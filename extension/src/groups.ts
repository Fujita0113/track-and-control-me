import { DEFAULTS, TAB_GROUP_ID_NONE, WINDOW_ID_NONE } from '@track/contract';
import type { GroupColor, GroupRef, IdleState } from '@track/contract';
import { withLock } from './state';

/**
 * アクティブグループ・openGroupKeys の算出（design.md D1）と、
 * 揮発的な chrome groupId を安定 UUID に写像する stableGroupId マネージャ
 * （design.md 「stableGroupId」）。
 *
 * フォールバック同一性 = `title + ' ' + color`。groupId で引けなければ
 * (title,color) で既存の安定IDを探し、それも無ければ新規採番する。
 *
 * `byGroupId` は `{stableId, title, color}` を保持し、直前値との比較で改名候補を検出する
 * （design.md D3・spec: tab-group-rename-tracking）。
 */

// groupId(string) -> {stableId, title, color}
const GROUP_BY_ID_KEY = 'groupStableMap';
// "title color" -> stableGroupId(UUID)（再起動で groupId が変わっても引き継ぐ）
const GROUP_BY_IDENTITY_KEY = 'groupIdentityMap';

interface GroupIdEntry {
  stableId: string;
  title: string;
  color: GroupColor;
}

interface GroupMaps {
  byGroupId: Record<string, GroupIdEntry>;
  byIdentity: Record<string, string>;
}

function identityKey(title: string, color: GroupColor): string {
  return `${title} ${color}`;
}

/** タブグループ改名の (旧名,旧色) → (新名,新色) の組（サーバーへ送る形と同一・design D3）。 */
export interface RenamePair {
  from: { name: string; color: GroupColor };
  to: { name: string; color: GroupColor };
}

/**
 * 直前の `byGroupId` エントリと新しい title/color を比べ、改名候補かどうかを判定する純粋関数。
 * 直前の title が空文字（＝新規グループへの命名）は改名として扱わない（MUST NOT・design D3）。
 * 変化が無ければ null。
 */
export function detectRenameCandidate(
  prevEntry: GroupIdEntry | undefined,
  title: string,
  color: GroupColor,
): RenamePair | null {
  if (!prevEntry || !prevEntry.title) return null;
  if (prevEntry.title === title && prevEntry.color === color) return null;
  return { from: { name: prevEntry.title, color: prevEntry.color }, to: { name: title, color } };
}

/**
 * 保留中の改名候補へ新しい変化を併合する純粋関数（design D3: 静止5秒デバウンス）。
 * 既に保留があれば `from` は最初のまま据え置き、`to` だけ最新へ更新する
 * （入力途中の連続更新から確定後の1組だけが残る）。
 */
export function mergeRenamePending(existing: RenamePair | undefined, next: RenamePair): RenamePair {
  return existing ? { from: existing.from, to: next.to } : next;
}

/** 保留候補が実質的な変化を表すか（from === to になった揺り戻しは送出しない）。 */
function isNoopRename(pair: RenamePair): boolean {
  return pair.from.name === pair.to.name && pair.from.color === pair.to.color;
}

async function loadMaps(): Promise<GroupMaps> {
  const res = await chrome.storage.local.get([GROUP_BY_ID_KEY, GROUP_BY_IDENTITY_KEY]);
  return {
    byGroupId: (res[GROUP_BY_ID_KEY] as Record<string, GroupIdEntry> | undefined) ?? {},
    byIdentity: (res[GROUP_BY_IDENTITY_KEY] as Record<string, string> | undefined) ?? {},
  };
}

async function saveMaps(maps: GroupMaps): Promise<void> {
  await chrome.storage.local.set({
    [GROUP_BY_ID_KEY]: maps.byGroupId,
    [GROUP_BY_IDENTITY_KEY]: maps.byIdentity,
  });
}

/**
 * maps 上で1グループの stableGroupId を確定する（無ければ採番）。
 * maps を破壊的に更新し、変更があったかを changed で返す。
 */
function resolveOnMaps(
  maps: GroupMaps,
  groupId: number,
  title: string,
  color: GroupColor,
): { stableId: string; changed: boolean } {
  const gk = String(groupId);
  const ik = identityKey(title, color);
  // 新規作成直後は一瞬 title=='' になる。空タイトルは色が同じであれば
  // どのグループでも同じ identity キーになってしまい、無関係な既存グループの
  // stableGroupId を誤って引き継いでしまう（新規採番前提を壊す）。
  // 空タイトルの間は identity での引き当て・書き込みの両方を行わない。
  const hasMeaningfulTitle = title.length > 0;
  let changed = false;
  const existing = maps.byGroupId[gk];
  let stable = existing?.stableId;
  if (stable === undefined) {
    stable = (hasMeaningfulTitle ? maps.byIdentity[ik] : undefined) ?? crypto.randomUUID();
    changed = true;
  }
  if (!existing || existing.stableId !== stable || existing.title !== title || existing.color !== color) {
    maps.byGroupId[gk] = { stableId: stable, title, color };
    changed = true;
  }
  if (hasMeaningfulTitle && maps.byIdentity[ik] !== stable) {
    maps.byIdentity[ik] = stable;
    changed = true;
  }
  return { stableId: stable, changed };
}

// ---------------------------------------------------------------------------
// 改名検出のデバウンス保留（design D3・spec: tab-group-rename-tracking）
// ---------------------------------------------------------------------------
const PENDING_RENAME_KEY = 'pendingGroupRename';
const RENAME_DEBOUNCE_MS = 5000;

/** groupId -> setTimeout ハンドル。SW 再起動をまたいでは残らない（意図どおり。保留は storage 側が持つ）。 */
const renameTimers = new Map<number, ReturnType<typeof setTimeout>>();

async function loadPendingRenames(): Promise<Record<string, RenamePair>> {
  const res = await chrome.storage.local.get(PENDING_RENAME_KEY);
  return (res[PENDING_RENAME_KEY] as Record<string, RenamePair> | undefined) ?? {};
}

async function savePendingRenames(map: Record<string, RenamePair>): Promise<void> {
  await chrome.storage.local.set({ [PENDING_RENAME_KEY]: map });
}

/** 改名候補を保留へ併合し、静止5秒のデバウンスタイマーを再設定する。 */
async function registerRenameCandidate(
  groupId: number,
  candidate: RenamePair,
  onRenameCandidate: (pair: RenamePair) => Promise<void> | void,
): Promise<void> {
  await withLock(async () => {
    const map = await loadPendingRenames();
    map[String(groupId)] = mergeRenamePending(map[String(groupId)], candidate);
    await savePendingRenames(map);
  });

  const existingTimer = renameTimers.get(groupId);
  if (existingTimer !== undefined) clearTimeout(existingTimer);
  renameTimers.set(
    groupId,
    setTimeout(() => {
      void flushOneRenameCandidate(groupId, onRenameCandidate);
    }, RENAME_DEBOUNCE_MS),
  );
}

/** 静止5秒経過後（またはウェイク時の補填で個別に）1件の保留改名を取り出して送出する。 */
async function flushOneRenameCandidate(
  groupId: number,
  onRenameCandidate: (pair: RenamePair) => Promise<void> | void,
): Promise<void> {
  renameTimers.delete(groupId);
  const pair = await withLock(async () => {
    const map = await loadPendingRenames();
    const key = String(groupId);
    const pending = map[key];
    if (!pending) return null;
    delete map[key];
    await savePendingRenames(map);
    return pending;
  });
  if (pair && !isNoopRename(pair)) await onRenameCandidate(pair);
}

/**
 * SW ウェイク時（`bootstrap`）に呼ぶ。前回 SW 停止でデバウンスタイマーが失われた保留中の
 * 改名候補をすべて送出する（design D3・Risks「デバウンス中の SW 停止」）。
 */
export async function flushPendingRenames(
  onRenameCandidate: (pair: RenamePair) => Promise<void> | void,
): Promise<void> {
  const map = await withLock(async () => {
    const m = await loadPendingRenames();
    if (Object.keys(m).length > 0) await savePendingRenames({});
    return m;
  });
  for (const pair of Object.values(map)) {
    if (!isNoopRename(pair)) await onRenameCandidate(pair);
  }
}

/**
 * tabGroups.onUpdated を受けてマップを更新（title/color 変更を同一安定IDに写像）し、
 * 改名候補を検出したらデバウンス保留へ積む（design D3）。
 */
export async function onGroupUpserted(
  group: chrome.tabGroups.TabGroup,
  onRenameCandidate?: (pair: RenamePair) => Promise<void> | void,
): Promise<void> {
  const title = group.title ?? '';
  const color = group.color as GroupColor;
  const candidate = await withLock(async () => {
    const maps = await loadMaps();
    const prevEntry = maps.byGroupId[String(group.id)];
    const rename = detectRenameCandidate(prevEntry, title, color);
    const r = resolveOnMaps(maps, group.id, title, color);
    if (r.changed) await saveMaps(maps);
    return rename;
  });
  if (candidate && onRenameCandidate) {
    await registerRenameCandidate(group.id, candidate, onRenameCandidate);
  }
}

/** tabGroups.onRemoved を受けて groupId の写像を落とす（identity は再作成時の再利用に残す）。 */
export async function onGroupRemovedFromMap(group: chrome.tabGroups.TabGroup): Promise<void> {
  await withLock(async () => {
    const maps = await loadMaps();
    const gk = String(group.id);
    if (maps.byGroupId[gk] !== undefined) {
      delete maps.byGroupId[gk];
      await saveMaps(maps);
    }
  });
}

/**
 * ブラウザ再起動（onStartup）時に byGroupId マップ全体を破棄する。
 * chrome.tabGroups の groupId はブラウザセッション内でのみ有効な揮発値で、
 * 再起動後は採番がリセットされ、以前のセッションで別グループが使っていた
 * groupId が新しいグループに再利用されうる。onRemoved は再起動をまたいで
 * 発火しないため、キャッシュを残したままだと groupId が一致しただけで
 * 無関係な旧グループの stableGroupId（＝旧タイトル・色）に取り違えてしまう。
 * byIdentity（title+color）マップは再起動をまたぐ同一性維持のために残す。
 */
export async function resetGroupIdMapOnStartup(): Promise<void> {
  await withLock(async () => {
    const maps = await loadMaps();
    if (Object.keys(maps.byGroupId).length > 0) {
      maps.byGroupId = {};
      await saveMaps(maps);
    }
  });
}

/**
 * 同一解決パス内で2つ以上のグループが同じ stableGroupId を持たないことを保証する不変条件
 * （design D7-2・spec: extension-stable-group-id）。groupId 昇順（＝先に観測された方）で走査し、
 * 初出の stableId は保持、2 回目以降に現れた（groupId が大きい方の）グループへ新しい UUID を
 * 再採番する。`entries[].ref`（openGroupKeys の要素）と `maps.byGroupId` の両方を書き換える
 * （破壊的）。戻り値は変更があったか。
 */
function dedupeStableIds(maps: GroupMaps, entries: { groupId: number; ref: GroupRef }[]): boolean {
  let changed = false;
  const seen = new Set<string>();
  const sorted = [...entries].sort((a, b) => a.groupId - b.groupId);
  for (const e of sorted) {
    const sid = e.ref.stableGroupId;
    if (!seen.has(sid)) {
      seen.add(sid);
      continue;
    }
    const fresh = crypto.randomUUID();
    e.ref.stableGroupId = fresh;
    maps.byGroupId[String(e.groupId)] = { stableId: fresh, title: e.ref.title, color: e.ref.color };
    seen.add(fresh);
    changed = true;
  }
  return changed;
}

// resolveOnMaps の空タイトル識別子バグ修正、および今回の重複再採番・改名検出の導入に伴い、
// 既存ストレージに残った誤った byGroupId/byIdentity エントリを一度だけ全消去するマイグレーション。
const GROUP_MAP_SCHEMA_VERSION = 3;
const GROUP_MAP_SCHEMA_VERSION_KEY = 'groupMapSchemaVersion';

/**
 * 拡張機能の起動（onInstalled：新規インストール／更新／リロード）ごとに呼ぶ。
 * schema version が古ければ byGroupId・byIdentity を丸ごと消去し、以後は
 * 修正済みロジックで各グループに新規の stableGroupId が振り直される。
 * ブラウザ再起動を待たずに反映させるための一回限りの補正。
 */
export async function migrateGroupMapsIfNeeded(): Promise<void> {
  await withLock(async () => {
    const res = await chrome.storage.local.get(GROUP_MAP_SCHEMA_VERSION_KEY);
    const current = (res[GROUP_MAP_SCHEMA_VERSION_KEY] as number | undefined) ?? 1;
    if (current >= GROUP_MAP_SCHEMA_VERSION) return;
    await chrome.storage.local.set({
      [GROUP_BY_ID_KEY]: {},
      [GROUP_BY_IDENTITY_KEY]: {},
      [GROUP_MAP_SCHEMA_VERSION_KEY]: GROUP_MAP_SCHEMA_VERSION,
    });
  });
}

/** 現時点の状態を chrome.* API から能動的に収集した結果。 */
export interface GatheredState {
  active: {
    /** アクティブタブのグループ。-1 = 未グループ。 */
    groupId: number;
    /** 未グループ/アクティブ無しは null。 */
    stableGroupId: string | null;
    title: string | null;
    color: GroupColor | null;
    windowId: number;
    tabId: number | null;
  };
  /** 現在開いている全グループ集合（divide-by-N の分母）。 */
  openGroupKeys: GroupRef[];
  idleState: IdleState;
  browserFocused: boolean;
}

/**
 * design.md D3：ハートビート/遷移のたびに能動的に状態を問い合わせる。
 * idle 状態・全グループ・最後にフォーカスされたウィンドウ・アクティブタブを取得し、
 * stableGroupId を解決して GatheredState を組み立てる。
 */
export async function gatherState(): Promise<GatheredState> {
  const [idleState, allGroups, lastWindow, activeTabs] = await Promise.all([
    chrome.idle.queryState(DEFAULTS.IDLE_DETECTION_SECONDS),
    chrome.tabGroups.query({}),
    chrome.windows.getLastFocused().catch((): chrome.windows.Window | undefined => undefined),
    chrome.tabs
      .query({ active: true, lastFocusedWindow: true })
      .catch((): chrome.tabs.Tab[] => []),
  ]);

  // 計上停止条件にはしないが、faithfully に報告する（design.md D4）。
  const browserFocused = lastWindow?.focused === true;
  const activeTab = activeTabs[0];

  return withLock(async () => {
    const maps = await loadMaps();
    let changed = false;

    const openGroupKeys: GroupRef[] = allGroups.map((g) => {
      const title = g.title ?? '';
      const color = g.color as GroupColor;
      const r = resolveOnMaps(maps, g.id, title, color);
      if (r.changed) changed = true;
      return { groupId: g.id, stableGroupId: r.stableId, title, color };
    });

    // 不変条件: 同一解決パス内で2グループが同じ stableGroupId を持ってはならない（design D7-2）。
    // 汚染された写像で重複した場合、groupId が大きい方（後発）を再採番する。
    if (dedupeStableIds(maps, allGroups.map((g, i) => ({ groupId: g.id, ref: openGroupKeys[i]! })))) {
      changed = true;
    }

    let active: GatheredState['active'];
    if (activeTab && activeTab.groupId !== TAB_GROUP_ID_NONE) {
      const g = allGroups.find((x) => x.id === activeTab.groupId);
      const title = g?.title ?? '';
      const color = (g?.color ?? 'grey') as GroupColor;
      // allGroups に含まれる限り dedup 後の確定値が既に byGroupId にある。無ければ防御的に解決する。
      let stableId = maps.byGroupId[String(activeTab.groupId)]?.stableId;
      if (stableId === undefined) {
        const r = resolveOnMaps(maps, activeTab.groupId, title, color);
        stableId = r.stableId;
        if (r.changed) changed = true;
      }
      active = {
        groupId: activeTab.groupId,
        stableGroupId: stableId,
        title,
        color,
        windowId: activeTab.windowId,
        tabId: activeTab.id ?? null,
      };
    } else if (activeTab) {
      // 未グループのアクティブタブ：安定ID/タイトル/色は null、groupId は -1。
      active = {
        groupId: TAB_GROUP_ID_NONE,
        stableGroupId: null,
        title: null,
        color: null,
        windowId: activeTab.windowId,
        tabId: activeTab.id ?? null,
      };
    } else {
      // 全ウィンドウ非フォーカス等でアクティブタブが取れないケース。
      active = {
        groupId: TAB_GROUP_ID_NONE,
        stableGroupId: null,
        title: null,
        color: null,
        windowId: WINDOW_ID_NONE,
        tabId: null,
      };
    }

    if (changed) await saveMaps(maps);
    return { active, openGroupKeys, idleState, browserFocused };
  });
}
