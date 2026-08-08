import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../db/index.js';
import { zonedTimeToEpoch } from '../aggregation/index.js';
import { createGoal, getGoal, getGoalReport, goalPace, type GoalView } from './goals.js';
import { evaluateDay } from '../rules/evaluate.js';
import {
  sameDayFreeze,
  sameDayFreezeMulti,
  sameDayFreezeQuota,
  reserveFreeze,
  updateFreeze,
  releaseFreeze,
  getFreeze,
  freezeQuota,
  FreezeValidationError,
  FreezeStateError,
} from './goal-freeze.js';

/**
 * 当日発効の凍結（spec: goal-freeze ADDED「当日発効の凍結は『今日1日だけ』」）。
 *
 * 「明日面接、この課題を持ってこい」のように**今夜ノルマを外す必要がある**正当な事情のための手段。
 * 翌日発効の期間凍結（`goal-freeze.test.ts`）とは代金が違う:
 *
 *   期間凍結: 翌日から効く / 凍結日数ぶん期限が延びる / 期間を指定できる / 延長できる
 *   当日凍結: 今日から効く / **期限は延びない** / 今日1日だけ / **延長できない**
 *
 * 枠は両者で共有（アプリ全体で月1回）。時間軸は JST 固定、目標は 2026-07-01 開始・2026-07-30 終了。
 */

const TZ = 'Asia/Tokyo';
const jst = (y: number, mo: number, d: number, h = 12, mi = 0) => zonedTimeToEpoch(y, mo, d, h, mi, 0, TZ);

const GOAL_END = '2026-07-30';
const NOW_0701 = jst(2026, 7, 1);
const NOW_0710 = jst(2026, 7, 10);
const NOW_0711 = jst(2026, 7, 11);
const NOW_0715 = jst(2026, 7, 15);
const NOW_0731 = jst(2026, 7, 31);
const NOW_0801 = jst(2026, 8, 1);

const REASON = '明日の面接に持っていく課題を今夜潰す';

let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
});

/** 総作業時間ルール1本つきの目標（2026-07-01 開始・7/30 終了）。 */
function makeGoal(name = '設計理解をしたい', nowMs = NOW_0701): GoalView {
  return createGoal(
    db,
    {
      name,
      purpose: '設計を読めるようになる',
      startReason: '始める理由',
      endDay: GOAL_END,
      start: 'today',
      rules: [{ target: 'TOTAL_WORK', thresholdSeconds: 14400, reason: '4時間は守りたい' }],
    },
    nowMs,
  );
}

/** 目標時間つきの目標（ペースの分母＝経過日数を見るため）。 */
function makeGoalWithHours(name = '設計理解をしたい'): GoalView {
  return createGoal(
    db,
    {
      name,
      purpose: '設計を読めるようになる',
      startReason: '始める理由',
      endDay: GOAL_END,
      start: 'today',
      rules: [{ target: 'TOTAL_WORK', thresholdSeconds: 14400, reason: '4時間は守りたい' }],
      targetHours: { kind: 'TOTAL_WORK', secondsPerDay: 2 * 3600 },
    },
    NOW_0701,
  );
}

// --- 当日発効（今日1日だけ）----------------------------------------------------

describe('当日凍結は今日のうちに効く', () => {
  it('7/10 に当日凍結すると start_day も end_day も 7/10 で、その日のゲートから外れる', () => {
    const g = makeGoal();
    // 前提: 凍結前は 7/10 のゲートにこの目標のルールが1本ある。
    expect(evaluateDay(db, '2026-07-10', NOW_0710).perCondition).toHaveLength(1);

    const f = sameDayFreeze(db, g.id, { reason: REASON }, NOW_0710);
    expect(f.kind).toBe('same_day');
    expect(f.startDay).toBe('2026-07-10');
    expect(f.endDay).toBe('2026-07-10');
    expect(f.state).toBe('frozen');
    expect(f.reason).toBe(REASON);

    // 今夜のノルマが外れる（これが当日凍結の目的そのもの）。
    expect(evaluateDay(db, '2026-07-10', NOW_0710).perCondition).toHaveLength(0);
  });

  it('翌日にはひとりでに解凍され、ゲートへ戻る', () => {
    const g = makeGoal();
    sameDayFreeze(db, g.id, { reason: REASON }, NOW_0710);
    expect(getFreeze(db, g.id, NOW_0711)?.state).toBe('released');
    expect(evaluateDay(db, '2026-07-11', NOW_0711).perCondition).toHaveLength(1);
  });

  it('理由が空の当日凍結は拒否され、凍結は作られない', () => {
    const g = makeGoal();
    expect(() => sameDayFreeze(db, g.id, { reason: '   ' }, NOW_0710)).toThrow(FreezeValidationError);
    expect(getFreeze(db, g.id, NOW_0710)).toBeNull();
    expect(evaluateDay(db, '2026-07-10', NOW_0710).perCondition).toHaveLength(1);
  });

  it('複数の目標へまとめて当日凍結できる（1回の枠で全部が外れる）', () => {
    const a = makeGoal('設計理解をしたい');
    const b = makeGoal('茶色取りたい');
    const res = sameDayFreezeMulti(db, [a.id, b.id], { reason: REASON }, NOW_0710);
    expect(res).toHaveLength(2);
    expect(res.every((f) => f.kind === 'same_day' && f.startDay === '2026-07-10')).toBe(true);
    expect(evaluateDay(db, '2026-07-10', NOW_0710).perCondition).toHaveLength(0);
  });

  it('当日凍結中の目標には期間凍結を予約できない（同時に持てる凍結は1つ）', () => {
    const g = makeGoal();
    sameDayFreeze(db, g.id, { reason: REASON }, NOW_0710);
    expect(() => reserveFreeze(db, g.id, { endDay: '2026-07-14', reason: 'ついでに' }, NOW_0710)).toThrow(FreezeStateError);
  });
});

// --- 代金: 期限は延びない ------------------------------------------------------

describe('当日凍結は期限を延ばさない（当日発効の代金）', () => {
  it('当日凍結しても実効 end_day は変わらない', () => {
    const g = makeGoal();
    sameDayFreeze(db, g.id, { reason: REASON }, NOW_0710);
    expect(getGoal(db, g.id, NOW_0711).endDay).toBe(GOAL_END);
    // 残り日数は 1 日減る（M が伸びないまま N だけ進む）。
    expect(getGoalReport(db, g.id, NOW_0711).goal.dayCount).toBe(30);
  });

  it('期間凍結は従来どおり期限を延ばす（当日凍結との差が代金である）', () => {
    const g = makeGoal();
    // 7/10 に予約 → 7/11 発効・7/12 まで。7/12 時点で 2 日ぶん適用済み。
    reserveFreeze(db, g.id, { endDay: '2026-07-12', reason: '出張' }, NOW_0710);
    expect(getGoal(db, g.id, jst(2026, 7, 12)).endDay).toBe('2026-08-01');
  });

  it('凍結した日はペースの分母（経過日数）から抜ける', () => {
    const g = makeGoalWithHours();
    // 凍結が無ければ 7/1〜7/11 の 11 日。
    expect(goalPace(db, g.id, NOW_0711)!.elapsedDays).toBe(11);
    sameDayFreeze(db, g.id, { reason: REASON }, NOW_0710);
    expect(goalPace(db, g.id, NOW_0711)!.elapsedDays).toBe(10);
  });

  it('凍結した日は達成カレンダーで対象外（frozen）になる', () => {
    const g = makeGoal();
    sameDayFreeze(db, g.id, { reason: REASON }, NOW_0710);
    const rep = getGoalReport(db, g.id, NOW_0711);
    const cell = rep.rules[0]!.cells.find((c) => c.dayKey === '2026-07-10')!;
    expect(cell.frozen).toBe(true);
  });
});

// --- 延長の禁止・解除 -----------------------------------------------------------

describe('当日凍結は延長できないが、解除はできる', () => {
  it('当日凍結の延長は拒否される（期間凍結へのロンダリングを塞ぐ）', () => {
    const g = makeGoal();
    sameDayFreeze(db, g.id, { reason: REASON }, NOW_0710);
    expect(() => updateFreeze(db, g.id, { endDay: '2026-07-11', reason: 'もう1日' }, NOW_0710)).toThrow(FreezeStateError);
    expect(getFreeze(db, g.id, NOW_0710)!.endDay).toBe('2026-07-10');
  });

  it('同じ日のうちに解除すると、その日のゲートへ戻り、期限も延びない', () => {
    const g = makeGoal();
    sameDayFreeze(db, g.id, { reason: REASON }, NOW_0710);
    releaseFreeze(db, g.id, NOW_0710);
    expect(evaluateDay(db, '2026-07-10', NOW_0710).perCondition).toHaveLength(1);
    expect(getGoal(db, g.id, NOW_0710).endDay).toBe(GOAL_END);
  });

  it('解除しても月枠は戻らない（発効した凍結は枠を解放しない）', () => {
    const g = makeGoal();
    const other = makeGoal('茶色取りたい');
    sameDayFreeze(db, g.id, { reason: REASON }, NOW_0710);
    releaseFreeze(db, g.id, NOW_0710);
    expect(() => sameDayFreeze(db, other.id, { reason: 'もう一度' }, NOW_0715)).toThrow(FreezeStateError);
  });
});

// --- 月枠は期間凍結と共有 -------------------------------------------------------

describe('当日凍結と期間凍結は同じ月枠を奪い合う', () => {
  it('当日凍結は同じ月の期間凍結の枠を塞ぐ', () => {
    const a = makeGoal('設計理解をしたい');
    const b = makeGoal('茶色取りたい');
    sameDayFreeze(db, a.id, { reason: REASON }, NOW_0710);
    expect(() => reserveFreeze(db, b.id, { endDay: '2026-07-25', reason: '出張' }, NOW_0715)).toThrow(FreezeStateError);
  });

  it('期間凍結は同じ月の当日凍結の枠を塞ぐ', () => {
    const a = makeGoal('設計理解をしたい');
    const b = makeGoal('茶色取りたい');
    reserveFreeze(db, a.id, { endDay: '2026-07-20', reason: '出張' }, NOW_0710);
    expect(() => sameDayFreeze(db, b.id, { reason: REASON }, NOW_0715)).toThrow(FreezeStateError);
  });

  it('当日凍結の枠は today の月、期間凍結の枠は翌日の月で数える（月末だけ食い違う）', () => {
    const a = makeGoal('設計理解をしたい');
    const b = makeGoal('茶色取りたい');
    // 7/31 に予約すると 8/1 発効＝8月の枠を消費する。
    reserveFreeze(db, a.id, { endDay: '2026-08-05', reason: '帰省' }, NOW_0731);
    expect(freezeQuota(db, NOW_0731).month).toBe('2026-08');
    expect(freezeQuota(db, NOW_0731).used).toBe(true);
    // 同じ 7/31 の当日凍結が見るのは 7 月の枠なので、まだ空いている。
    expect(sameDayFreezeQuota(db, NOW_0731).month).toBe('2026-07');
    expect(sameDayFreezeQuota(db, NOW_0731).used).toBe(false);
    const f = sameDayFreeze(db, b.id, { reason: REASON }, NOW_0731);
    expect(f.startDay).toBe('2026-07-31');
    // 8/1 発効の予約はそのまま残っている。
    expect(getFreeze(db, a.id, NOW_0801)?.state).toBe('frozen');
  });

  it('月が変われば当日凍結の枠は回復する', () => {
    const a = makeGoal('設計理解をしたい');
    sameDayFreeze(db, a.id, { reason: REASON }, NOW_0710);
    expect(() => sameDayFreeze(db, a.id, { reason: 'もう一度' }, NOW_0801)).not.toThrow();
  });
});
