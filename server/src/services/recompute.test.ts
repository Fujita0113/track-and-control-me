import { describe, it, expect } from 'vitest';
import { openDb, type DB } from '../db/index.js';
import { zonedTimeToEpoch } from '../aggregation/index.js';
import { loadRawSamples, recomputeWindowStartMs } from './recompute.js';

/**
 * issue #82 / change: recompute-scoped-window
 * `recompute(db, { onlyDays })` が raw_sample 全件を毎回読み直していたことで、
 * ingest デバウンス経由の再計算が raw_sample の総件数に比例して遅くなり、
 * 他の API リクエストをブロックしていた（実測: 49,111件で recompute() 約4.9秒）。
 * ここでは「対象日＋1日バッファ以降のみ読み込む」絞り込みをテストする。
 */

const TZ = 'Asia/Tokyo';
const BOUNDARY_MIN = 240; // 04:00
const jst = (y: number, mo: number, d: number, h: number, mi: number) =>
  zonedTimeToEpoch(y, mo, d, h, mi, 0, TZ);

function insertSample(db: DB, bootId: string, seq: number, clientTs: number): void {
  const group = { groupId: 1, stableGroupId: 'g-dev', title: '開発', color: 'green' };
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
    group.groupId,
    group.stableGroupId,
    group.title,
    group.color,
    JSON.stringify([group]),
    clientTs,
  );
}

describe('recompute のスコープ絞り込み（change: recompute-scoped-window）', () => {
  it('recomputeWindowStartMs は対象日のうち最古日から1日前倒しした日境界開始時刻を返す', () => {
    const targetDay = '2026-08-03';
    const expected = jst(2026, 8, 2, 4, 0); // prevDayKey(2026-08-03) = 2026-08-02 の 04:00 境界開始
    expect(recomputeWindowStartMs([targetDay], TZ, BOUNDARY_MIN)).toBe(expected);

    // 複数日指定時は最古日を基準にする
    expect(recomputeWindowStartMs(['2026-08-03', '2026-08-02'], TZ, BOUNDARY_MIN)).toBe(
      jst(2026, 8, 1, 4, 0),
    );

    // onlyDays 未指定/空は絞り込み無し（undefined）
    expect(recomputeWindowStartMs(undefined, TZ, BOUNDARY_MIN)).toBeUndefined();
    expect(recomputeWindowStartMs([], TZ, BOUNDARY_MIN)).toBeUndefined();
  });

  it('loadRawSamples は sinceMs より前のサンプルを除外する', () => {
    const db = openDb(':memory:');
    const farPast = jst(2026, 7, 1, 12, 0);
    const justBefore = jst(2026, 8, 2, 3, 0); // sinceMs の1時間前（除外されるべき）
    const sinceMs = jst(2026, 8, 2, 4, 0);
    const justAfter = jst(2026, 8, 2, 5, 0); // sinceMs の1時間後（含まれるべき）

    insertSample(db, 'boot', 1, farPast);
    insertSample(db, 'boot', 2, justBefore);
    insertSample(db, 'boot', 3, justAfter);

    const all = loadRawSamples(db);
    expect(all.length).toBe(3); // sinceMs 未指定時は全件（後方互換）

    const scoped = loadRawSamples(db, { sinceMs });
    expect(scoped.map((s) => s.clientTs)).toEqual([justAfter]);
    db.close();
  });

  it('対象日の直前1日分の履歴が raw_sample に大量にあっても、対象範囲外のサンプルは読み込まれない', () => {
    const db = openDb(':memory:');
    const targetDay = '2026-08-03';
    const windowStart = recomputeWindowStartMs([targetDay], TZ, BOUNDARY_MIN)!;

    // 対象範囲より前（3日以上前）に大量の「無関係な履歴」を積む。
    let seq = 0;
    for (let d = 10; d >= 3; d--) {
      insertSample(db, 'boot', seq++, jst(2026, 7, 31 - d, 12, 0));
    }
    // バッファ日（対象日の1日前）に、境界をまたぐ直前サンプルを1件。
    insertSample(db, 'boot', seq++, windowStart + 30_000);
    // 対象日当日のサンプル。
    insertSample(db, 'boot', seq++, jst(2026, 8, 3, 10, 0));

    const scoped = loadRawSamples(db, { sinceMs: windowStart });
    // 無関係な過去履歴（7件）は含まれず、バッファ日の直前1件＋対象日1件のみ。
    expect(scoped.length).toBe(2);
    expect(scoped.every((s) => s.clientTs >= windowStart)).toBe(true);
    db.close();
  });
});
