import { DEFAULTS } from '@track/contract';
import type { EventType, IdleState } from '@track/contract';
import { getAwayMinSeconds, getWsConfig } from './config';
import {
  gatherState,
  migrateGroupMapsIfNeeded,
  onGroupRemovedFromMap,
  onGroupUpserted,
  resetGroupIdMapOnStartup,
} from './groups';
import { buildSample } from './sampler';
import {
  claimAwayNotification,
  ensureBootId,
  getBootId,
  loadSnapshot,
  nextSeq,
  regenerateBootId,
  saveSnapshot,
} from './state';
import type { Snapshot } from './state';
import { WsClient } from './ws-client';

/**
 * Service Worker エントリ（design.md D3）。
 * イベント購読・ハートビートアラーム・WS を配線する。SW は約30秒で停止するため、
 * すべてのハンドラは storage / chrome.* を真実の源として状態を読み直す。
 */

const HEARTBEAT_ALARM = 'heartbeat';
const wsClient = new WsClient();

/**
 * 共通のサンプル発火：能動的に状態収集 → サンプル生成 → スナップショット永続 → 送信。
 * seq は storage の read-modify-write で採番するため SW 再起動をまたいで一意。
 */
async function emitSample(eventType: EventType): Promise<void> {
  const [gathered, prev, bootId] = await Promise.all([
    gatherState(),
    loadSnapshot(),
    getBootId(),
  ]);
  const seq = await nextSeq();
  const sample = buildSample(eventType, gathered, bootId, seq);
  const now = sample.clientTs;

  // 離席復帰の判定と通知（design D7）。閾値以上の離席から active へ戻ったら1回だけ通知する。
  const lastAwayNotifiedTs = await maybeNotifyAwayReturn(prev, gathered.idleState, now);

  const snapshot: Snapshot = {
    activeGroupId: gathered.active.groupId,
    stableGroupId: gathered.active.stableGroupId,
    title: gathered.active.title,
    color: gathered.active.color,
    windowId: gathered.active.windowId,
    tabId: gathered.active.tabId,
    browserFocused: gathered.browserFocused,
    idleState: gathered.idleState,
    openGroupKeys: gathered.openGroupKeys,
    lastActiveTs: gathered.idleState === 'active' ? now : prev?.lastActiveTs ?? 0,
    lastHeartbeatTs: eventType === 'HEARTBEAT' ? now : prev?.lastHeartbeatTs ?? 0,
    lastEventType: eventType,
    lastAwayNotifiedTs,
  };
  await saveSnapshot(snapshot);
  await wsClient.sendSample(sample);
}

// ---------------------------------------------------------------------------
// 離席復帰通知（design D7 / spec away-return-prompt）
// ---------------------------------------------------------------------------
const AWAY_NOTIFICATION_PREFIX = 'away-return';
let cachedAwayIcon: string | null = null;

/**
 * 離席復帰の判定。現在 active かつ「最終 active から閾値以上」経過していれば通知する。
 * idle/locked 遷移（emitSample）でもスリープ・再起動復帰（bootstrap/onStartup）でも同一判定で捕捉できる。
 * @returns 永続すべき `lastAwayNotifiedTs`（未通知時は従前値を維持）。
 */
async function maybeNotifyAwayReturn(
  prev: Snapshot | null,
  currentIdle: IdleState,
  now: number,
): Promise<number> {
  const prevNotified = prev?.lastAwayNotifiedTs ?? 0;
  if (!prev || currentIdle !== 'active') return prevNotified;
  const awayStart = prev.lastActiveTs;
  if (!awayStart) return prevNotified;
  const awayMs = now - awayStart;
  const thresholdMs = (await getAwayMinSeconds()) * 1000;
  if (awayMs < thresholdMs) return prevNotified;
  // 同一離席区間への重複通知は原子的な claim で1回に抑止（並行ウェイク間でも安全）。
  if (await claimAwayNotification(awayStart)) await createAwayNotification(awayStart, now);
  return awayStart;
}

/** SW ウェイク時（スリープ・ブラウザ再起動復帰を含む）に離席復帰を補足判定する。 */
async function checkAwayReturnOnWake(): Promise<void> {
  const prev = await loadSnapshot();
  if (!prev) return;
  let currentIdle: IdleState;
  try {
    currentIdle = (await chrome.idle.queryState(DEFAULTS.IDLE_DETECTION_SECONDS)) as IdleState;
  } catch {
    return;
  }
  const notifiedTs = await maybeNotifyAwayReturn(prev, currentIdle, Date.now());
  if (notifiedTs !== (prev.lastAwayNotifiedTs ?? 0)) {
    await saveSnapshot({ ...prev, lastAwayNotifiedTs: notifiedTs });
  }
}

/** 離席区間を id へ埋め込み、クリックでディープリンクを再構成できる通知を作る。 */
async function createAwayNotification(awayStart: number, now: number): Promise<void> {
  const mins = Math.max(1, Math.round((now - awayStart) / 60000));
  const id = `${AWAY_NOTIFICATION_PREFIX}:${awayStart}:${now}`;
  try {
    await chrome.notifications.create(id, {
      type: 'basic',
      iconUrl: await awayIcon(),
      title: '離席を記録しませんか？',
      message: `${hhmm(awayStart)} – ${hhmm(now)}（${mins}分）離席していました`,
      priority: 1,
    });
  } catch {
    // notifications 権限やアイコン生成に失敗しても計測本体は継続する（通知は補助経路）。
  }
}

/** 通知アイコンを OffscreenCanvas で生成（外部アセット不要・self-contained）。1回だけ生成しキャッシュ。 */
async function awayIcon(): Promise<string> {
  if (cachedAwayIcon) return cachedAwayIcon;
  try {
    const canvas = new OffscreenCanvas(128, 128);
    const g = canvas.getContext('2d');
    if (!g) throw new Error('no 2d context');
    g.fillStyle = '#1a73e8';
    g.fillRect(0, 0, 128, 128);
    g.fillStyle = '#ffffff';
    g.font = '600 74px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('⏱', 64, 72);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    const buf = await blob.arrayBuffer();
    let bin = '';
    for (const b of new Uint8Array(buf)) bin += String.fromCharCode(b);
    cachedAwayIcon = `data:image/png;base64,${btoa(bin)}`;
  } catch {
    // フォールバック: 1x1 の青ドット PNG。
    cachedAwayIcon =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP4z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  }
  return cachedAwayIcon;
}

/** epoch ms → "HH:MM"（ローカル tz）。 */
function hhmm(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 30秒周期のハートビートアラームを（無ければ）作成する。 */
async function ensureHeartbeatAlarm(): Promise<void> {
  const existing = await chrome.alarms.get(HEARTBEAT_ALARM);
  if (!existing) {
    await chrome.alarms.create(HEARTBEAT_ALARM, {
      delayInMinutes: 0,
      periodInMinutes: DEFAULTS.HEARTBEAT_SECONDS / 60, // = 0.5
    });
  }
}

/** SW ウェイクごとの初期化：idle 検出間隔・bootId・アラーム・WS 接続。 */
async function bootstrap(): Promise<void> {
  chrome.idle.setDetectionInterval(DEFAULTS.IDLE_DETECTION_SECONDS);
  await ensureBootId();
  await migrateGroupMapsIfNeeded();
  await ensureHeartbeatAlarm();
  // スリープ・再起動復帰など idle 遷移イベントを取りこぼしうるウェイクでも復帰通知を補足する。
  await checkAwayReturnOnWake();
  await wsClient.connect();
}

// ---------------------------------------------------------------------------
// ライフサイクル
// ---------------------------------------------------------------------------
chrome.runtime.onInstalled.addListener(() => {
  void bootstrap();
});

// 新しいブラウザセッション：bootId を振り直して (bootId,seq) の一意性を保つ。
// groupId は前セッションの値が引き継がれない（採番リセット・再利用の恐れがある）ため、
// byGroupId キャッシュも合わせて破棄する。
chrome.runtime.onStartup.addListener(() => {
  void (async () => {
    // 復帰判定は bootId 振り直しの前に（旧セッションの lastActiveTs を参照するため）。
    await checkAwayReturnOnWake();
    await regenerateBootId();
    await resetGroupIdMapOnStartup();
    chrome.idle.setDetectionInterval(DEFAULTS.IDLE_DETECTION_SECONDS);
    await ensureHeartbeatAlarm();
    await wsClient.reconnect();
  })();
});

// ---------------------------------------------------------------------------
// ハートビート（能動的に状態問い合わせ → 送信）
// ---------------------------------------------------------------------------
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== HEARTBEAT_ALARM) return;
  void (async () => {
    await wsClient.connect();
    await emitSample('HEARTBEAT');
  })();
});

// ---------------------------------------------------------------------------
// 遷移イベント（即時送信。design.md D3）
// ---------------------------------------------------------------------------
chrome.tabs.onActivated.addListener(() => {
  void emitSample('TAB_ACTIVATED');
});

chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  // グループ所属変更時のみ（changeInfo.groupId が定義されているとき）。
  if (changeInfo.groupId !== undefined) void emitSample('TAB_GROUP_CHANGED');
});

chrome.tabGroups.onUpdated.addListener((group) => {
  void (async () => {
    await onGroupUpserted(group);
    await emitSample('GROUP_UPDATED');
  })();
});

chrome.tabGroups.onRemoved.addListener((group) => {
  void (async () => {
    await onGroupRemovedFromMap(group);
    await emitSample('GROUP_REMOVED');
  })();
});

chrome.windows.onFocusChanged.addListener(() => {
  void emitSample('WINDOW_FOCUS_CHANGED');
});

chrome.idle.onStateChanged.addListener(() => {
  void emitSample('IDLE_STATE_CHANGED');
});

// ---------------------------------------------------------------------------
// 離席通知クリック → ダッシュボードのタイムラインを区間プリフィルで開く（design D7/D8）
// ---------------------------------------------------------------------------
chrome.notifications.onClicked.addListener((notificationId) => {
  if (!notificationId.startsWith(`${AWAY_NOTIFICATION_PREFIX}:`)) return;
  void (async () => {
    // id 形式: away-return:<fromMs>:<toMs>
    const [, from, to] = notificationId.split(':');
    const { wsPort } = await getWsConfig();
    const url = `http://127.0.0.1:${wsPort}/#timeline?from=${from}&to=${to}`;
    try {
      await chrome.tabs.create({ url });
    } catch {
      /* タブ生成失敗（サーバー停止等）はゴーストスロットで回収するため握りつぶす。 */
    }
    chrome.notifications.clear(notificationId);
  })();
});

// ---------------------------------------------------------------------------
// popup からの指示（設定変更の即時反映）
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message) => {
  if (message && typeof message === 'object' && message.type === 'applyConfig') {
    void wsClient.reconnect();
  }
});

// SW 起動（wake）ごとに走るトップレベル初期化。
void bootstrap();
