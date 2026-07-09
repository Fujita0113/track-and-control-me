import { describe, it, expect } from 'vitest';
import { openDb, type DB } from '../db/index.js';
import { zonedTimeToEpoch } from '../aggregation/index.js';
import { runRollover } from './rollover.js';
import { recompute } from './recompute.js';

const TZ = 'Asia/Tokyo';
const jst = (y: number, mo: number, d: number, h: number, mi: number) =>
  zonedTimeToEpoch(y, mo, d, h, mi, 0, TZ);

function insertSample(
  db: DB,
  bootId: string,
  seq: number,
  clientTs: number,
  openGroups: { groupId: number; stableGroupId: string; title: string; color: string }[],
): void {
  const active = openGroups[0]!;
  db.prepare(
    `INSERT INTO raw_sample
      (boot_id, seq, client_ts, monotonic_ms, tz, event_type, active_group_id,
       active_stable_group_id, active_title, active_color, window_id, tab_id,
       idle_state, browser_focused, open_group_keys, ext_version, received_at)
     VALUES (?, ?, ?, ?, 'Asia/Tokyo', 'HEARTBEAT', ?, ?, ?, ?, 1, 1, 'active', 0, ?, '0.1.0', ?)`,
  ).run(
    bootId,
    seq,
    clientTs,
    seq * 60_000,
    active.groupId,
    active.stableGroupId,
    active.title,
    active.color,
    JSON.stringify(openGroups),
    clientTs,
  );
}

describe('日次ロールオーバー（7.1）', () => {
  it('前日を確定（is_final）し、確定後は再計算で変化しない', () => {
    const db = openDb(':memory:');
    const groups = [{ groupId: 3, stableGroupId: 'g-dev', title: '開発', color: 'green' }];
    // 昨日（2026-07-09 12:00〜）に 5 区間分のサンプル。
    const base = jst(2026, 7, 9, 12, 0);
    for (let k = 0; k <= 5; k++) insertSample(db, 'boot', k, base + k * 60_000, groups);

    // 今日（2026-07-10 04:30）に rollover。
    runRollover(db, jst(2026, 7, 10, 4, 30));

    const y = db
      .prepare("SELECT ms, is_final FROM daily_totals_snapshot WHERE day_key = '2026-07-09' AND stable_group_id = 'g-dev'")
      .get() as { ms: number; is_final: number } | undefined;
    expect(y).toBeDefined();
    expect(y!.ms).toBe(5 * 60_000); // 5 区間 x 60s
    expect(y!.is_final).toBe(1);

    const evalRow = db
      .prepare("SELECT is_final FROM unlock_evaluation WHERE day_key = '2026-07-09'")
      .get() as { is_final: number } | undefined;
    expect(evalRow?.is_final).toBe(1);

    // 確定後にサンプルを追加して再計算しても、確定日は変わらない。
    insertSample(db, 'boot', 100, base + 100 * 60_000, groups);
    recompute(db);
    const y2 = db
      .prepare("SELECT ms FROM daily_totals_snapshot WHERE day_key = '2026-07-09' AND stable_group_id = 'g-dev'")
      .get() as { ms: number };
    expect(y2.ms).toBe(5 * 60_000); // 保護されている
    db.close();
  });
});
