import { describe, it, expect } from 'vitest';
import { UNGROUPED_KEY } from '@track/contract';
import { openDb, type DB } from '../db/index.js';
import { zonedTimeToEpoch } from '../aggregation/index.js';
import { getDayAllocation } from './day-allocation.js';
import { daySummary } from './summary.js';

/**
 * 一日の配分集計（spec: reflection-day-overview）。
 * 持ち分（credited）で重複計上しないこと・円が端〜端でちょうど閉じること・
 * 先頭末尾の境界空白が母数外であること・記録ゼロで母数ゼロを返すことを担保する。
 */

const TZ = 'Asia/Tokyo';
const DAY = '2026-07-06';
const jst = (h: number, mi: number) => zonedTimeToEpoch(2026, 7, 6, h, mi, 0, TZ);

/** AUTO セッションを1件挿入（credited_ms は同時オープン ÷n 済みの持ち分を明示指定）。 */
function insertSession(
  db: DB,
  group: string,
  title: string,
  startAt: number,
  endAt: number,
  n = 1,
  creditedMs = (endAt - startAt) / n,
): void {
  db.prepare(
    `INSERT INTO session
      (stable_group_id, tab_group_name_snapshot, group_color_snapshot, category_key_snapshot,
       started_at, ended_at, day_key, coactive_group_keys, n, credited_ms, close_reason, created_at)
     VALUES (?, ?, 'blue', NULL, ?, ?, ?, '[]', ?, ?, 'NORMAL', ?)`,
  ).run(group, title, startAt, endAt, DAY, n, creditedMs, endAt);
}

/** MANUAL エントリを1件挿入（n で持ち分 span/n が決まる）。 */
function insertManual(
  db: DB,
  category: string,
  startAt: number,
  endAt: number,
  n = 1,
): void {
  db.prepare(
    `INSERT INTO activity_log_entry
      (day_key, start_at, end_at, entry_type, title, color, category_key, coactive_group_keys,
       n, co_record_group_id, edited, created_at, updated_at)
     VALUES (?, ?, ?, 'MANUAL', ?, 'grey', ?, '[]', ?, NULL, 0, ?, ?)`,
  ).run(DAY, startAt, endAt, category, category, n, endAt, endAt);
}

describe('getDayAllocation', () => {
  it('(a) 2グループ同時2h → 各1h・合計2h（重複計上しない）', () => {
    const db = openDb(':memory:');
    // 09:00–11:00 を 2 グループが同時記録（各 n=2 → credited=1h ずつ）。
    insertSession(db, 'grpA', 'A', jst(9, 0), jst(11, 0), 2);
    insertSession(db, 'grpB', 'B', jst(9, 0), jst(11, 0), 2);
    const a = getDayAllocation(db, DAY, jst(11, 0));
    const work = a.slices.filter((s) => s.kind === 'WORK');
    expect(work).toHaveLength(2);
    expect(work.every((s) => s.seconds === 3600)).toBe(true);
    const workTotal = work.reduce((acc, s) => acc + s.seconds, 0);
    expect(workTotal).toBe(2 * 3600); // 4h ではない
    expect(a.totalSeconds).toBe(2 * 3600);
    expect(a.untrackedSeconds).toBe(0);
  });

  it('(b) 端〜端9hで持ち分7h＋未記録2hが母数9hに一致（円が閉じる）', () => {
    const db = openDb(':memory:');
    // 09:00–14:00 作業5h、14:00–16:00 未記録、16:00–18:00 作業2h。持ち分計7h。
    insertSession(db, 'grpA', 'A', jst(9, 0), jst(14, 0));
    insertSession(db, 'grpA', 'A', jst(16, 0), jst(18, 0));
    const a = getDayAllocation(db, DAY, jst(18, 0));
    expect(a.totalSeconds).toBe(9 * 3600);
    const sliceTotal = a.slices.reduce((acc, s) => acc + s.seconds, 0);
    expect(sliceTotal).toBe(7 * 3600);
    expect(a.untrackedSeconds).toBe(2 * 3600);
    expect(sliceTotal + a.untrackedSeconds).toBe(a.totalSeconds);
  });

  it('(c) 先頭・末尾の境界空白は母数に含めない', () => {
    const db = openDb(':memory:');
    // 日境界 4:00 だが、最初の記録 9:00・最後の記録 18:00。母数は 9h。
    insertSession(db, 'grpA', 'A', jst(9, 0), jst(18, 0));
    const a = getDayAllocation(db, DAY, jst(18, 0));
    expect(a.extentStart).toBe(jst(9, 0));
    expect(a.extentEnd).toBe(jst(18, 0));
    expect(a.totalSeconds).toBe(9 * 3600);
    expect(a.untrackedSeconds).toBe(0);
  });

  it('(d) 記録ゼロで母数0・空スライス', () => {
    const db = openDb(':memory:');
    const a = getDayAllocation(db, DAY, jst(18, 0));
    expect(a.totalSeconds).toBe(0);
    expect(a.slices).toHaveLength(0);
    expect(a.untrackedSeconds).toBe(0);
    expect(a.extentStart).toBeNull();
    expect(a.extentEnd).toBeNull();
  });

  it('作業と自己申告（休憩）が別スライスで計上される', () => {
    const db = openDb(':memory:');
    insertSession(db, 'grpA', 'A', jst(9, 0), jst(15, 0)); // 作業6h
    insertManual(db, '休憩', jst(15, 0), jst(16, 0)); // 自己申告1h
    // 16:00–18:00 未記録2h（当日 now=18:00）。
    const a = getDayAllocation(db, DAY, jst(18, 0));
    expect(a.totalSeconds).toBe(9 * 3600);
    const work = a.slices.find((s) => s.kind === 'WORK');
    const manual = a.slices.find((s) => s.kind === 'MANUAL');
    expect(work?.seconds).toBe(6 * 3600);
    expect(manual?.seconds).toBe(1 * 3600);
    expect(a.untrackedSeconds).toBe(2 * 3600);
    // 秒降順で並ぶ。
    expect(a.slices[0]!.seconds).toBeGreaterThanOrEqual(a.slices[1]!.seconds);
  });

  it('(e) 同名同色・別 stable_group_id の作業が1つの WORK スライスへ合算される（issue #47）', () => {
    const db = openDb(':memory:');
    // 「振り返り」(blue) を、開き直しで別 stable_group_id になった 30 分 × 6 回として記録。
    // 09:00–12:00 の 6 区間（各 n=1 → credited=30min）。tl の coalesce を跨がないよう区間を離す。
    for (let i = 0; i < 6; i++) {
      const s = jst(9 + Math.floor(i / 2), (i % 2) * 30);
      const e = jst(9 + Math.floor((i + 1) / 2), ((i + 1) % 2) * 30);
      insertSession(db, `reflect-${i}`, '振り返り', s, e); // 別 group_id・同名同色
    }
    // 勉強(blue とは別グループ)を 2h、比較用に別スライスとして。
    insertSession(db, 'study', '勉強', jst(12, 0), jst(14, 0));
    const a = getDayAllocation(db, DAY, jst(14, 0));
    const work = a.slices.filter((s) => s.kind === 'WORK');
    // 振り返りは6分割されず1本（3h）へ合算される。勉強と合わせて WORK は2スライスのみ。
    expect(work).toHaveLength(2);
    const reflect = work.find((s) => s.label === '振り返り')!;
    expect(reflect).toBeDefined();
    expect(reflect.seconds).toBe(3 * 3600);
    expect(reflect.key).toBe('work:振り返り\x1fblue');

    // (f) WORK 各スライス合計 = today-group-breakdown（daySummary）の同グループ合計に一致（ドリフト防止）。
    const summary = daySummary(db, DAY);
    for (const w of work) {
      const g = summary.groups.find((gr) => gr.name === w.label)!;
      expect(g, `daySummary に ${w.label} が無い`).toBeDefined();
      expect(w.seconds).toBe(Math.round(g.seconds));
    }
  });

  it('(g) 未グループ（UNGROUPED_KEY）は名前が違っても単一スライスへ集約される', () => {
    const db = openDb(':memory:');
    // 未グループの作業を、記録時点の名前が異なる複数セッションとして記録（すべて UNGROUPED_KEY）。
    insertSession(db, UNGROUPED_KEY, '無題A', jst(9, 0), jst(10, 0));
    insertSession(db, UNGROUPED_KEY, '無題B', jst(10, 0), jst(11, 0));
    const a = getDayAllocation(db, DAY, jst(11, 0));
    const work = a.slices.filter((s) => s.kind === 'WORK');
    expect(work).toHaveLength(1);
    expect(work[0]!.key).toBe(`work:${UNGROUPED_KEY}`);
    expect(work[0]!.label).toBe('その他（未グループ）');
    expect(work[0]!.color).toBeNull();
    expect(work[0]!.seconds).toBe(2 * 3600);
  });
});
