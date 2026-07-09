import type { EventType, GroupColor, GroupRef, IdleState } from '@track/contract';

/**
 * chrome.storage.local を単一の真実の源とする永続状態ヘルパ。
 *
 * MV3 の Service Worker は約30秒アイドルで停止し、メモリ上のグローバルを失う。
 * そのため bootId / seq / スナップショット / 送信待ちキューは全て storage に置き、
 * SW が起き直すたびに読み直す（design.md 「State persistence」）。
 */

// ---------------------------------------------------------------------------
// storage キー
// ---------------------------------------------------------------------------
const BOOT_ID_KEY = 'bootId';
const SEQ_KEY = 'seq';
const SNAPSHOT_KEY = 'snapshot';
const QUEUE_KEY = 'queue';

/** 送信待ちキューの上限（超過分は古い方から捨てる）。 */
const QUEUE_CAP = 2000;

// ---------------------------------------------------------------------------
// 直列化ロック
// ---------------------------------------------------------------------------
// chrome.storage は非同期のため、read-modify-write が並行イベントで競合しうる。
// 1つの SW ウェイク内では Promise チェーンで直列化して seq / マップ / キューの
// 更新をアトミックにする。ウェイクをまたぐ整合性は storage 自体が担保する。
let lockChain: Promise<unknown> = Promise.resolve();

/** fn を直前のロック取得者の完了後に直列実行する（簡易ミューテックス）。 */
export function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = lockChain.then(fn, fn);
  lockChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// ---------------------------------------------------------------------------
// bootId / seq
// ---------------------------------------------------------------------------

/** bootId が無ければ発行して保存し、返す。seq は 0 に初期化する。 */
export async function ensureBootId(): Promise<string> {
  return withLock(async () => {
    const res = await chrome.storage.local.get([BOOT_ID_KEY, SEQ_KEY]);
    const existing = res[BOOT_ID_KEY];
    if (typeof existing === 'string' && existing.length > 0) return existing;
    const created = crypto.randomUUID();
    await chrome.storage.local.set({ [BOOT_ID_KEY]: created, [SEQ_KEY]: 0 });
    return created;
  });
}

/** 新しいブラウザセッション（onStartup）用に bootId を振り直し、seq を 0 に戻す。 */
export async function regenerateBootId(): Promise<string> {
  return withLock(async () => {
    const created = crypto.randomUUID();
    await chrome.storage.local.set({ [BOOT_ID_KEY]: created, [SEQ_KEY]: 0 });
    return created;
  });
}

/** 現在の bootId を返す（無ければ発行）。 */
export async function getBootId(): Promise<string> {
  const res = await chrome.storage.local.get(BOOT_ID_KEY);
  const existing = res[BOOT_ID_KEY];
  if (typeof existing === 'string' && existing.length > 0) return existing;
  return ensureBootId();
}

/** bootId 内で単調増加する次の seq を read-modify-write で返す。 */
export async function nextSeq(): Promise<number> {
  return withLock(async () => {
    const res = await chrome.storage.local.get(SEQ_KEY);
    const raw = res[SEQ_KEY];
    const current = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
    const next = current + 1;
    await chrome.storage.local.set({ [SEQ_KEY]: next });
    return next;
  });
}

// ---------------------------------------------------------------------------
// スナップショット（popup 表示・遷移値の引き継ぎ用）
// ---------------------------------------------------------------------------

/** 現在の在席・アクティブグループ・開いているグループ集合のスナップショット。 */
export interface Snapshot {
  activeGroupId: number;
  stableGroupId: string | null;
  title: string | null;
  color: GroupColor | null;
  windowId: number;
  tabId: number | null;
  browserFocused: boolean;
  idleState: IdleState;
  openGroupKeys: GroupRef[];
  /** 最後に active だった壁時計（ms）。 */
  lastActiveTs: number;
  /** 最後にハートビートを送った壁時計（ms）。 */
  lastHeartbeatTs: number;
  /** 直近に発火したイベント種別。 */
  lastEventType: EventType;
}

export async function saveSnapshot(snapshot: Snapshot): Promise<void> {
  await chrome.storage.local.set({ [SNAPSHOT_KEY]: snapshot });
}

export async function loadSnapshot(): Promise<Snapshot | null> {
  const res = await chrome.storage.local.get(SNAPSHOT_KEY);
  const s = res[SNAPSHOT_KEY];
  return s ? (s as Snapshot) : null;
}

// ---------------------------------------------------------------------------
// 送信待ちキュー（切断中の ClientMessage JSON 文字列を貯める）
// ---------------------------------------------------------------------------

function readQueue(res: { [key: string]: unknown }): string[] {
  const raw = res[QUEUE_KEY];
  return Array.isArray(raw) ? (raw as string[]) : [];
}

/** メッセージ群を末尾に追加する。上限超過は古い方から破棄する。 */
export async function enqueueMessages(messages: string[]): Promise<void> {
  if (messages.length === 0) return;
  await withLock(async () => {
    const res = await chrome.storage.local.get(QUEUE_KEY);
    let merged = readQueue(res).concat(messages);
    if (merged.length > QUEUE_CAP) merged = merged.slice(merged.length - QUEUE_CAP);
    await chrome.storage.local.set({ [QUEUE_KEY]: merged });
  });
}

/** 送信に失敗した残りを先頭へ戻す（順序保持。self-timestamped なので厳密順不要）。 */
export async function requeueFront(messages: string[]): Promise<void> {
  if (messages.length === 0) return;
  await withLock(async () => {
    const res = await chrome.storage.local.get(QUEUE_KEY);
    let merged = messages.concat(readQueue(res));
    if (merged.length > QUEUE_CAP) merged = merged.slice(merged.length - QUEUE_CAP);
    await chrome.storage.local.set({ [QUEUE_KEY]: merged });
  });
}

/** キュー全体を取り出してクリアする（flush 用のアトミックな drain）。 */
export async function drainQueue(): Promise<string[]> {
  return withLock(async () => {
    const res = await chrome.storage.local.get(QUEUE_KEY);
    const items = readQueue(res);
    if (items.length > 0) await chrome.storage.local.set({ [QUEUE_KEY]: [] });
    return items;
  });
}

/** 現在のキュー長（popup 表示用）。 */
export async function queueLength(): Promise<number> {
  const res = await chrome.storage.local.get(QUEUE_KEY);
  return readQueue(res).length;
}
