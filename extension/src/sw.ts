import { DEFAULTS } from '@track/contract';
import type { EventType } from '@track/contract';
import { gatherState, onGroupRemovedFromMap, onGroupUpserted } from './groups';
import { buildSample } from './sampler';
import {
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
  };
  await saveSnapshot(snapshot);
  await wsClient.sendSample(sample);
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
  await ensureHeartbeatAlarm();
  await wsClient.connect();
}

// ---------------------------------------------------------------------------
// ライフサイクル
// ---------------------------------------------------------------------------
chrome.runtime.onInstalled.addListener(() => {
  void bootstrap();
});

// 新しいブラウザセッション：bootId を振り直して (bootId,seq) の一意性を保つ。
chrome.runtime.onStartup.addListener(() => {
  void (async () => {
    await regenerateBootId();
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
// popup からの指示（設定変更の即時反映）
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message) => {
  if (message && typeof message === 'object' && message.type === 'applyConfig') {
    void wsClient.reconnect();
  }
});

// SW 起動（wake）ごとに走るトップレベル初期化。
void bootstrap();
