import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../db/index.js';
import { zonedTimeToEpoch } from '../aggregation/index.js';
import { upsertFutureRuleSet } from '../rules/rules.js';
import {
  adoptCandidates,
  createGoal,
  listGoals,
  deleteGoal,
  getGoalReport,
  saveJournal,
  getJournal,
  GoalDeleteWindowError,
  GoalReportNotReadyError,
  JournalNotWritableError,
  GoalPracticeError,
} from './goals.js';

const TZ = 'Asia/Tokyo';
const jst = (y: number, mo: number, d: number, h: number, mi: number) =>
  zonedTimeToEpoch(y, mo, d, h, mi, 0, TZ);

// 「今日」= 2026-07-10 → 目標は翌日 2026-07-11 開始・2026-08-09 完了。
const NOW_TODAY = jst(2026, 7, 10, 12, 0);
const NOW_NEXT = jst(2026, 7, 11, 12, 0);
const NOW_COMPLETED = jst(2026, 8, 10, 12, 0);
const START = '2026-07-11';
const END = '2026-08-09';

let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
});

/** 翌日(2026-07-11)発効の実効ルール = 採用元。 */
function seedTomorrowRule(): void {
  upsertFutureRuleSet(
    db,
    START,
    {
      conditions: [
        { target: 'TOTAL_WORK', thresholdSeconds: 14400 },
        { target: 'GROUP', stableGroupId: 'g-atcoder', thresholdSeconds: 1800 },
        { target: 'PLANNING', signalKey: 'reflection_done' },
        { target: 'MANUAL_CHECK', label: '振り返り', conditionKey: 'manual:3' },
      ],
    },
    NOW_TODAY,
  );
}

function seedEval(dayKey: string, per: unknown[]): void {
  db.prepare(
    `INSERT INTO unlock_evaluation (day_key, status, conditions_met, per_condition_results, first_met_at, reveal_fired, is_final, updated_at)
     VALUES (?, 'LOCKED', 0, ?, NULL, 0, 0, 0)`,
  ).run(dayKey, JSON.stringify(per));
}

describe('目標の作成・採用', () => {
  it('採用候補は翌日実効ルールから出て MANUAL_CHECK を除外する', () => {
    seedTomorrowRule();
    const cands = adoptCandidates(db, NOW_TODAY);
    const keys = cands.map((c) => c.conditionKey).sort();
    expect(keys).toEqual(['group:g-atcoder', 'planning:reflection_done', 'total_work']);
    expect(cands.some((c) => c.conditionKey.startsWith('manual:'))).toBe(false);
  });

  it('作成すると翌日開始・30日固定（end=+29）で開始前になる', () => {
    seedTomorrowRule();
    const g = createGoal(db, { name: 'メンタルを安定させる', purpose: '穏やかに', practices: ['total_work'] }, NOW_TODAY);
    expect(g.startDay).toBe(START);
    expect(g.endDay).toBe(END);
    expect(g.status).toBe('upcoming');
    expect(g.dayCount).toBe(30);
  });

  it('翌日実効ルールに無い実践は採用できない', () => {
    seedTomorrowRule();
    expect(() =>
      createGoal(db, { name: 'x', practices: ['group:does-not-exist'] }, NOW_TODAY),
    ).toThrow(GoalPracticeError);
    // MANUAL_CHECK 由来のキーも候補外。
    expect(() => createGoal(db, { name: 'x', practices: ['manual:3'] }, NOW_TODAY)).toThrow(
      GoalPracticeError,
    );
  });

  it('並行して2つ作成でき、採用実践の重複も許容される', () => {
    seedTomorrowRule();
    createGoal(db, { name: 'A', practices: ['total_work'] }, NOW_TODAY);
    createGoal(db, { name: 'B', practices: ['total_work', 'group:g-atcoder'] }, NOW_TODAY);
    const goals = listGoals(db, NOW_TODAY);
    expect(goals.length).toBe(2);
  });

  it('TIMELINE 条件は採用候補に含まれ（manual:* は依然除外）、採用できる', () => {
    upsertFutureRuleSet(
      db,
      START,
      {
        conditions: [
          { target: 'TIMELINE', label: '運動', thresholdSeconds: 1800 },
          { target: 'MANUAL_CHECK', label: '振り返り', conditionKey: 'manual:1' },
        ],
      },
      NOW_TODAY,
    );
    const cands = adoptCandidates(db, NOW_TODAY);
    const tl = cands.find((c) => c.conditionKey === 'timeline:運動');
    expect(tl).toBeTruthy();
    expect(tl!.target).toBe('TIMELINE');
    expect(tl!.label).toBe('運動 30分以上'); // 「<カテゴリ> ◯分以上」・生キーは出さない
    expect(cands.some((c) => c.conditionKey.startsWith('manual:'))).toBe(false);
    // 採用可能（timeline:<ラベル> の安定キーで保存される）。
    const g = createGoal(db, { name: '運動習慣', practices: ['timeline:運動'] }, NOW_TODAY);
    expect(g.practices[0]!.conditionKey).toBe('timeline:運動');
    expect(g.practices[0]!.target).toBe('TIMELINE');
  });
});

describe('削除猶予（作成当日のみ）', () => {
  it('作成当日は削除でき、実践・日記も CASCADE で消える', () => {
    seedTomorrowRule();
    const g = createGoal(db, { name: 'A', practices: ['total_work'] }, NOW_TODAY);
    expect(deleteGoal(db, g.id, NOW_TODAY)).toBe(true);
    expect(listGoals(db, NOW_TODAY).length).toBe(0);
  });

  it('翌日以降は削除できない', () => {
    seedTomorrowRule();
    const g = createGoal(db, { name: 'A', practices: ['total_work'] }, NOW_TODAY);
    expect(() => deleteGoal(db, g.id, NOW_NEXT)).toThrow(GoalDeleteWindowError);
  });
});

describe('目標日記', () => {
  it('進行中の日は保存でき、reflection_done を汚染しない', () => {
    seedTomorrowRule();
    const g = createGoal(db, { name: 'A', practices: ['total_work'] }, NOW_TODAY);
    // 進行中（today=2026-07-11 が start..end 内）で保存。
    saveJournal(db, g.id, START, '初日の日記', NOW_NEXT);
    expect(getJournal(db, g.id, START).content).toBe('初日の日記');
    // reflection_entry には一切書かれない。
    expect((db.prepare('SELECT COUNT(*) AS c FROM reflection_entry').get() as { c: number }).c).toBe(0);
  });

  it('完走後の日記書き込みは拒否される', () => {
    seedTomorrowRule();
    const g = createGoal(db, { name: 'A', practices: ['total_work'] }, NOW_TODAY);
    expect(() => saveJournal(db, g.id, START, 'x', NOW_COMPLETED)).toThrow(JournalNotWritableError);
  });
});

describe('完了レポート', () => {
  it('完走前は 409（GoalReportNotReadyError）', () => {
    seedTomorrowRule();
    const g = createGoal(db, { name: 'A', practices: ['total_work'] }, NOW_TODAY);
    expect(() => getGoalReport(db, g.id, NOW_TODAY)).toThrow(GoalReportNotReadyError);
  });

  it('欠測=未達成、達成日数=全実践 met の日数、閾値マーカー、日単位フォールバック', () => {
    seedTomorrowRule();
    const g = createGoal(db, { name: 'A', practices: ['total_work', 'group:g-atcoder'] }, NOW_TODAY);

    // Day1(07-11): 両方 met。Day2(07-12): total_work のみ met。他28日: 評価行なし（欠測）。
    seedEval('2026-07-11', [
      { conditionKey: 'total_work', target: 'TOTAL_WORK', met: true, actualSeconds: 15000, thresholdSeconds: 14400 },
      { conditionKey: 'group:g-atcoder', target: 'GROUP', met: true, actualSeconds: 2000, thresholdSeconds: 1800 },
    ]);
    seedEval('2026-07-12', [
      { conditionKey: 'total_work', target: 'TOTAL_WORK', met: true, actualSeconds: 11000, thresholdSeconds: 10800 },
      { conditionKey: 'group:g-atcoder', target: 'GROUP', met: false, actualSeconds: 100, thresholdSeconds: 1800 },
    ]);
    // 閾値変更ログ（Day2 に 4h→3h）。
    db.prepare(
      `INSERT INTO practice_threshold_change (condition_key, effective_date, old_seconds, new_seconds, reason, created_at)
       VALUES ('total_work', '2026-07-12', 14400, 10800, '課題週間。ゼロにはしない', 0)`,
    ).run();
    // ③④ フォールバック: Day1 は振り返りのみ、Day30(08-09) は目標日記。
    db.prepare(
      `INSERT INTO reflection_entry (date, content, satisfaction, created_at, updated_at) VALUES ('2026-07-11', 'Day1 の振り返り', NULL, 0, 0)`,
    ).run();
    db.prepare(
      `INSERT INTO goal_journal (goal_id, day_key, content, created_at, updated_at) VALUES (?, '2026-08-09', 'Day30 の日記', 0, 0)`,
    ).run(g.id);

    const rep = getGoalReport(db, g.id, NOW_COMPLETED);

    expect(rep.goal.dayCount).toBe(30);
    expect(rep.goal.achievedDays).toBe(1); // Day1 のみ全実践 met
    expect(rep.hasTimeType).toBe(true);

    const total = rep.practices.find((p) => p.conditionKey === 'total_work')!;
    const group = rep.practices.find((p) => p.conditionKey === 'group:g-atcoder')!;
    expect(total.cells.length).toBe(30);
    expect(total.cells[0]!.met).toBe(true); // Day1
    expect(total.cells[1]!.met).toBe(true); // Day2
    expect(group.cells[1]!.met).toBe(false); // Day2 未達成
    expect(total.cells[2]!.met).toBe(false); // Day3 欠測=未達成

    expect(rep.thresholdChanges.length).toBe(1);
    expect(rep.thresholdChanges[0]!.dayNumber).toBe(2);
    expect(rep.thresholdChanges[0]!.reason).toContain('課題週間');

    expect(rep.days[0]!.source).toBe('reflection');
    expect(rep.days[0]!.text).toBe('Day1 の振り返り');
    expect(rep.days[29]!.source).toBe('journal');
    expect(rep.days[29]!.text).toBe('Day30 の日記');
  });

  it('TIMELINE 実践は①カレンダーに乗り、②時間推移（isTimeType）として扱われる', () => {
    upsertFutureRuleSet(
      db,
      START,
      { conditions: [{ target: 'TIMELINE', label: '運動', thresholdSeconds: 1800 }] },
      NOW_TODAY,
    );
    const g = createGoal(db, { name: '運動', practices: ['timeline:運動'] }, NOW_TODAY);
    seedEval('2026-07-11', [
      { conditionKey: 'timeline:運動', target: 'TIMELINE', met: true, actualSeconds: 2100, thresholdSeconds: 1800 },
    ]);
    const rep = getGoalReport(db, g.id, NOW_COMPLETED);
    const p = rep.practices.find((x) => x.conditionKey === 'timeline:運動')!;
    expect(p.isTimeType).toBe(true); // ② 時間推移に乗る
    expect(p.cells[0]!.met).toBe(true); // ① Day1 達成
    expect(p.cells[0]!.actualSeconds).toBe(2100);
    expect(p.cells[0]!.thresholdSeconds).toBe(1800);
    expect(rep.hasTimeType).toBe(true);
  });
});
