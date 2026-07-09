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
 */

// groupId(string) -> stableGroupId(UUID)
const GROUP_BY_ID_KEY = 'groupStableMap';
// "title color" -> stableGroupId(UUID)（再起動で groupId が変わっても引き継ぐ）
const GROUP_BY_IDENTITY_KEY = 'groupIdentityMap';

interface GroupMaps {
  byGroupId: Record<string, string>;
  byIdentity: Record<string, string>;
}

function identityKey(title: string, color: GroupColor): string {
  return `${title} ${color}`;
}

async function loadMaps(): Promise<GroupMaps> {
  const res = await chrome.storage.local.get([GROUP_BY_ID_KEY, GROUP_BY_IDENTITY_KEY]);
  return {
    byGroupId: (res[GROUP_BY_ID_KEY] as Record<string, string> | undefined) ?? {},
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
  let stable = maps.byGroupId[gk];
  if (stable === undefined) {
    stable = (hasMeaningfulTitle ? maps.byIdentity[ik] : undefined) ?? crypto.randomUUID();
    changed = true;
  }
  if (maps.byGroupId[gk] !== stable) {
    maps.byGroupId[gk] = stable;
    changed = true;
  }
  if (hasMeaningfulTitle && maps.byIdentity[ik] !== stable) {
    maps.byIdentity[ik] = stable;
    changed = true;
  }
  return { stableId: stable, changed };
}

/** tabGroups.onUpdated を受けてマップを更新（title/color 変更を同一安定IDに写像）。 */
export async function onGroupUpserted(group: chrome.tabGroups.TabGroup): Promise<void> {
  await withLock(async () => {
    const maps = await loadMaps();
    const r = resolveOnMaps(maps, group.id, group.title ?? '', group.color as GroupColor);
    if (r.changed) await saveMaps(maps);
  });
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

// resolveOnMaps の空タイトル識別子バグ修正に伴い、既存ストレージに残った
// 誤った byGroupId/byIdentity エントリを一度だけ全消去するマイグレーション。
const GROUP_MAP_SCHEMA_VERSION = 2;
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

    let active: GatheredState['active'];
    if (activeTab && activeTab.groupId !== TAB_GROUP_ID_NONE) {
      const g = allGroups.find((x) => x.id === activeTab.groupId);
      const title = g?.title ?? '';
      const color = (g?.color ?? 'grey') as GroupColor;
      const r = resolveOnMaps(maps, activeTab.groupId, title, color);
      if (r.changed) changed = true;
      active = {
        groupId: activeTab.groupId,
        stableGroupId: r.stableId,
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
