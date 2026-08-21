import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../db/index.js';
import { zonedTimeToEpoch } from '../aggregation/index.js';
import {
  createGoal,
  getGoal,
  endGoal,
  resumeGoal,
  cancelResumeGoal,
  type GoalView,
  GoalValidationError,
  GoalLifecycleError,
} from './goals.js';
import { evaluateDay } from '../rules/evaluate.js';

/**
 * 発効済みの終了は再開できる（spec: goal-lifecycle-fork ADDED・issue #103）。
 *
 * 「終える」に「再開する」を追加し、終了→再開のサイクルを**無制限**に繰り返せるようにする
 * （凍結の月1枠とは独立・消費しない）。再開は終了と対称の型（翌日発効・発効前は取消可・理由必須）。
 *
 * 終了していた期間は、凍結と同じ「無かった日」規則に従い、目標の実効 `end_day` を
 * 経過日数ぶん前方向へ延長し、ペースの分母・達成カレンダーからも除外する。
 *
 * 時間軸は JST 固定。目標は 2026-07-01 開始・2026-07-30 終了（30日）。
 */

const TZ = 'Asia/Tokyo';
const jst = (y: number, mo: number, d: number, h = 12, mi = 0) => zonedTimeToEpoch(y, mo, d, h, mi, 0, TZ);

const GOAL_END = '2026-07-30';
const NOW_0701 = jst(2026, 7, 1);
const NOW_0710 = jst(2026, 7, 10);
const NOW_0711 = jst(2026, 7, 11);
const NOW_0714 = jst(2026, 7, 14);
const NOW_0715 = jst(2026, 7, 15);
const NOW_0716 = jst(2026, 7, 16);
const NOW_0720 = jst(2026, 7, 20);
const NOW_0725 = jst(2026, 7, 25);
const NOW_0726 = jst(2026, 7, 26);

let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
});

function makeGoal(name = '設計理解をしたい', nowMs = NOW_0701, endDay = GOAL_END): GoalView {
  return createGoal(
    db,
    {
      startReason: '始める理由',
      endDay,
      name,
      purpose: '設計を読めるようになる',
      start: 'today',
      rules: [{ target: 'TOTAL_WORK', thresholdSeconds: 14400, reason: '4時間は守りたい' }],
    },
    nowMs,
  );
}

const END_REASON = '試験勉強はもう大丈夫。設計に切り替えたい';
const RESUME_REASON = 'コーディングテストが終わったので再開したい';

describe('発効済みの終了は再開できる', () => {
  it('発効済みの終了を理由つきで再開すると、翌日から進行中に戻る', () => {
    const g = makeGoal();
    endGoal(db, g.id, { reason: END_REASON }, NOW_0710); // ended_day_key = 7/11。
    expect(getGoal(db, g.id, NOW_0711).status).toBe('ended');

    const view = resumeGoal(db, g.id, { reason: RESUME_REASON }, NOW_0725);
    expect(view.status).toBe('ended'); // 再開要求を出した当日はまだ終了のまま。
    expect(view.resumingOn).toBe('2026-07-26');

    const next = getGoal(db, g.id, NOW_0726);
    expect(next.status).toBe('active');
    expect(next.resumingOn).toBeNull();
    // 永続ルールが解錠評価に戻る。
    expect(evaluateDay(db, '2026-07-26', NOW_0726).perCondition).toHaveLength(1);
  });

  it('再開を要求した当日はまだ終了のままで、解錠評価も変わらない', () => {
    const g = makeGoal();
    endGoal(db, g.id, { reason: END_REASON }, NOW_0710);
    resumeGoal(db, g.id, { reason: RESUME_REASON }, NOW_0725);
    expect(getGoal(db, g.id, NOW_0725).status).toBe('ended');
    expect(evaluateDay(db, '2026-07-25', NOW_0725).perCondition).toHaveLength(0);
  });

  it('理由が空の再開は拒否される', () => {
    const g = makeGoal();
    endGoal(db, g.id, { reason: END_REASON }, NOW_0710);
    expect(() => resumeGoal(db, g.id, { reason: '   ' }, NOW_0725)).toThrow(GoalValidationError);
    expect(getGoal(db, g.id, NOW_0725).resumingOn).toBeNull();
  });

  it('終了していない（進行中の）目標は再開できない', () => {
    const g = makeGoal();
    expect(() => resumeGoal(db, g.id, { reason: RESUME_REASON }, NOW_0710)).toThrow(GoalLifecycleError);
  });

  it('終了予約中（発効前）の目標も再開できない', () => {
    const g = makeGoal();
    endGoal(db, g.id, { reason: END_REASON }, NOW_0710); // ended_day_key = 7/11、まだ発効前。
    expect(() => resumeGoal(db, g.id, { reason: RESUME_REASON }, NOW_0710)).toThrow(GoalLifecycleError);
  });
});

describe('再開は発効前なら取り消せる', () => {
  it('発効前に取り消すと再開予約が消え、目標は終了のまま', () => {
    const g = makeGoal();
    endGoal(db, g.id, { reason: END_REASON }, NOW_0710);
    resumeGoal(db, g.id, { reason: RESUME_REASON }, NOW_0725);
    const view = cancelResumeGoal(db, g.id, NOW_0725);
    expect(view.status).toBe('ended');
    expect(view.resumingOn).toBeNull();
    expect(getGoal(db, g.id, NOW_0726).status).toBe('ended');
  });

  it('発効後の取消は拒否される', () => {
    const g = makeGoal();
    endGoal(db, g.id, { reason: END_REASON }, NOW_0710);
    resumeGoal(db, g.id, { reason: RESUME_REASON }, NOW_0725);
    expect(() => cancelResumeGoal(db, g.id, NOW_0726)).toThrow(GoalLifecycleError);
    expect(getGoal(db, g.id, NOW_0726).status).toBe('active');
  });

  it('再開予約が無い目標の取消は拒否される', () => {
    const g = makeGoal();
    endGoal(db, g.id, { reason: END_REASON }, NOW_0710);
    expect(() => cancelResumeGoal(db, g.id, NOW_0725)).toThrow(GoalLifecycleError);
  });
});

describe('終了→再開のサイクルは無制限に繰り返せる', () => {
  it('再開後に改めて理由つきで終えられる', () => {
    const g = makeGoal();
    endGoal(db, g.id, { reason: END_REASON }, NOW_0710);
    resumeGoal(db, g.id, { reason: RESUME_REASON }, NOW_0714);
    expect(getGoal(db, g.id, NOW_0716).status).toBe('active');

    const view = endGoal(db, g.id, { reason: '2回目の理由' }, NOW_0720);
    expect(view.status).toBe('active');
    expect(view.endingOn).toBe('2026-07-21');
  });

  it('サイクルを繰り返しても月枠を消費しない（無制限）', () => {
    const g = makeGoal();
    for (let i = 0; i < 3; i++) {
      endGoal(db, g.id, { reason: `終える${i}` }, NOW_0710);
      resumeGoal(db, g.id, { reason: `再開${i}` }, NOW_0711);
    }
    // 3回繰り返しても最後まで拒否されない（回数上限が無いことの確認）。
    expect(() => endGoal(db, g.id, { reason: '最後にもう一度' }, NOW_0720)).not.toThrow();
  });
});

describe('終了していた分だけ期限が延びる', () => {
  it('7/10 に終え（発効 7/11）7/14 に再開して（発効 7/15・終了していた期間は7/11〜7/14の4日間）、7/16 に見ると期限が4日延びている', () => {
    const g = makeGoal();
    endGoal(db, g.id, { reason: END_REASON }, NOW_0710); // ended_day_key = 7/11。
    resumeGoal(db, g.id, { reason: RESUME_REASON }, NOW_0714); // resumed_day_key = 7/15。

    const view = getGoal(db, g.id, NOW_0716);
    expect(view.status).toBe('active');
    expect(view.endDay).toBe('2026-08-03');
    expect(view.dayCount).toBe(34);
    expect(view.dayNumber).toBe(16);
  });

  // レポート（①達成カレンダーの frozen セル）は capability ごと廃止された
  // （spec: goal-report REMOVED・goal-burnup-forecast）。終了区間ぶん期限が延びる事実は
  // 直前のテストで getGoal() により検証済み。セル単位の frozen フラグに相当する
  // 読み手はどこにも残らないため、それを検証していたテストはここで意図的に落とす。
});
