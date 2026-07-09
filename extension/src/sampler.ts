import type { ActivitySample, EventType } from '@track/contract';
import type { GatheredState } from './groups';

/**
 * GatheredState と (bootId, seq) から契約の ActivitySample を組み立てる（純関数）。
 * clientTs は壁時計、monotonicMs は単調時計（時計ジャンプ検出用）。
 */

const EXT_VERSION = chrome.runtime.getManifest().version;
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

export function buildSample(
  eventType: EventType,
  gathered: GatheredState,
  bootId: string,
  seq: number,
): ActivitySample {
  const { active } = gathered;
  return {
    eventType,
    clientTs: Date.now(),
    monotonicMs: performance.now(),
    bootId,
    seq,
    tz: TZ,
    groupId: active.groupId,
    stableGroupId: active.stableGroupId,
    groupTitle: active.title,
    groupColor: active.color,
    windowId: active.windowId,
    tabId: active.tabId,
    idleState: gathered.idleState,
    browserFocused: gathered.browserFocused,
    openGroupKeys: gathered.openGroupKeys,
    extVersion: EXT_VERSION,
  };
}
