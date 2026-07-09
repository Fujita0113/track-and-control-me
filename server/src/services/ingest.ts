import type { ActivitySample } from '@track/contract';
import type { DB } from '../db/index.js';
import { upsertTabGroups } from './recompute.js';

/**
 * 受信サンプルの冪等保存（design.md D3/D6）。
 * (boot_id, seq) の UNIQUE 制約 + INSERT OR IGNORE で重複排除。順不同は
 * 保存時に許容（集計側が clientTs でソートするため）。
 */
export function storeSample(
  db: DB,
  sample: ActivitySample,
  receivedAt: number,
): { inserted: boolean } {
  const info = db
    .prepare(
      `INSERT OR IGNORE INTO raw_sample
        (boot_id, seq, client_ts, monotonic_ms, tz, event_type, active_group_id,
         active_stable_group_id, active_title, active_color, window_id, tab_id,
         idle_state, browser_focused, open_group_keys, ext_version, received_at)
       VALUES
        (@boot_id, @seq, @client_ts, @monotonic_ms, @tz, @event_type, @active_group_id,
         @active_stable_group_id, @active_title, @active_color, @window_id, @tab_id,
         @idle_state, @browser_focused, @open_group_keys, @ext_version, @received_at)`,
    )
    .run({
      boot_id: sample.bootId,
      seq: sample.seq,
      client_ts: sample.clientTs,
      monotonic_ms: sample.monotonicMs,
      tz: sample.tz,
      event_type: sample.eventType,
      active_group_id: sample.groupId,
      active_stable_group_id: sample.stableGroupId,
      active_title: sample.groupTitle,
      active_color: sample.groupColor,
      window_id: sample.windowId,
      tab_id: sample.tabId,
      idle_state: sample.idleState,
      browser_focused: sample.browserFocused ? 1 : 0,
      open_group_keys: JSON.stringify(sample.openGroupKeys),
      ext_version: sample.extVersion,
      received_at: receivedAt,
    });

  const inserted = info.changes > 0;
  if (inserted && sample.openGroupKeys.length > 0) {
    upsertTabGroups(db, sample.openGroupKeys, receivedAt);
  }
  return { inserted };
}
