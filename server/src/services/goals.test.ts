import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../db/index.js';
import { zonedTimeToEpoch } from '../aggregation/index.js';
import { upsertFutureRuleSet, getRuleSet } from '../rules/rules.js';
import {
  adoptCandidates,
  createGoal,
  listGoals,
  deleteGoal,
  getGoalReport,
  saveJournal,
  getJournal,
  listJournalImages,
  addJournalImage,
  getJournalImageBytes,
  updateJournalImageCaption,
  deleteJournalImage,
  addDaysKey,
  GoalDeleteWindowError,
  GoalReportNotReadyError,
  JournalNotWritableError,
  JournalImageError,
  JournalImageNotFoundError,
  GoalPracticeError,
} from './goals.js';

/** テスト用 data URL（バイト内容は検証しないので任意バイト列でよい）。 */
const dataUrl = (mime = 'image/png', bytes: number[] = [1, 2, 3]): string =>
  `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;

const TZ = 'Asia/Tokyo';
const jst = (y: number, mo: number, d: number, h: number, mi: number) =>
  zonedTimeToEpoch(y, mo, d, h, mi, 0, TZ);

// 「今日」= 2026-07-10 → 明日開始の目標は 2026-07-11 開始・2026-08-09 完了。
const NOW_TODAY = jst(2026, 7, 10, 12, 0);
const NOW_NEXT = jst(2026, 7, 11, 12, 0);
const NOW_COMPLETED = jst(2026, 8, 10, 12, 0);
const START = '2026-07-11';
const END = '2026-08-09';

let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
});

/** 翌日(2026-07-11)発効の実効ルール = 明日開始目標の採用元。 */
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

describe('目標の作成・採用（明日開始）', () => {
  it('採用候補は翌日実効ルールから出て MANUAL_CHECK を除外する', () => {
    seedTomorrowRule();
    const cands = adoptCandidates(db, NOW_TODAY, 'tomorrow');
    const keys = cands.map((c) => c.conditionKey).sort();
    expect(keys).toEqual(['group:g-atcoder', 'planning:reflection_done', 'total_work']);
    expect(cands.some((c) => c.conditionKey.startsWith('manual:'))).toBe(false);
  });

  it('明日開始で作成すると翌日開始・30日固定（end=+29）で開始前になる', () => {
    seedTomorrowRule();
    const g = createGoal(db, { name: 'メンタルを安定させる', purpose: '穏やかに', practices: ['total_work'], start: 'tomorrow' }, NOW_TODAY);
    expect(g.startDay).toBe(START);
    expect(g.endDay).toBe(END);
    expect(g.status).toBe('upcoming');
    expect(g.dayCount).toBe(30);
  });

  it('翌日実効ルールに無い実践は採用できない', () => {
    seedTomorrowRule();
    expect(() =>
      createGoal(db, { name: 'x', practices: ['group:does-not-exist'], start: 'tomorrow' }, NOW_TODAY),
    ).toThrow(GoalPracticeError);
    // MANUAL_CHECK 由来のキーも候補外。
    expect(() => createGoal(db, { name: 'x', practices: ['manual:3'], start: 'tomorrow' }, NOW_TODAY)).toThrow(
      GoalPracticeError,
    );
  });

  it('並行して2つ作成でき、採用実践の重複も許容される', () => {
    seedTomorrowRule();
    createGoal(db, { name: 'A', practices: ['total_work'], start: 'tomorrow' }, NOW_TODAY);
    createGoal(db, { name: 'B', practices: ['total_work', 'group:g-atcoder'], start: 'tomorrow' }, NOW_TODAY);
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
    const cands = adoptCandidates(db, NOW_TODAY, 'tomorrow');
    const tl = cands.find((c) => c.conditionKey === 'timeline:運動');
    expect(tl).toBeTruthy();
    expect(tl!.target).toBe('TIMELINE');
    expect(tl!.label).toBe('運動 30分以上'); // 「<カテゴリ> ◯分以上」・生キーは出さない
    expect(cands.some((c) => c.conditionKey.startsWith('manual:'))).toBe(false);
    // 採用可能（timeline:<ラベル> の安定キーで保存される）。
    const g = createGoal(db, { name: '運動習慣', practices: ['timeline:運動'], start: 'tomorrow' }, NOW_TODAY);
    expect(g.practices[0]!.conditionKey).toBe('timeline:運動');
    expect(g.practices[0]!.target).toBe('TIMELINE');
  });
});

describe('目標の開始日選択（今日開始）', () => {
  /** 「今日」(2026-07-10)発効の実効ルール（前日にコミット・当日凍結）を作る。 */
  function seedTodayRule(): void {
    upsertFutureRuleSet(
      db,
      '2026-07-10',
      { conditions: [{ target: 'TOTAL_WORK', thresholdSeconds: 14400 }] },
      jst(2026, 7, 9, 12, 0), // 前日にコミット → 当日は凍結ルール。
    );
  }

  it('既定（start 未指定）は今日開始になり、当日を Day1 として進行中で現れる', () => {
    seedTodayRule();
    const g = createGoal(db, { name: '今日から', practices: ['total_work'] }, NOW_TODAY);
    expect(g.startDay).toBe('2026-07-10');
    expect(g.endDay).toBe('2026-08-08'); // start + 29
    expect(g.status).toBe('active');
    expect(g.dayNumber).toBe(1);
    expect(g.dayCount).toBe(30);
  });

  it('採用候補は今日開始では当日実効ルールから出る', () => {
    seedTodayRule();
    const cands = adoptCandidates(db, NOW_TODAY, 'today');
    expect(cands.map((c) => c.conditionKey)).toContain('total_work');
  });

  it('明日開始は翌日から開始前で現れる', () => {
    seedTomorrowRule();
    const g = createGoal(db, { name: '明日から', practices: ['total_work'], start: 'tomorrow' }, NOW_TODAY);
    expect(g.startDay).toBe(START);
    expect(g.status).toBe('upcoming');
  });

  it('今日開始でインライン条件を作ると当日ルール（DRAFT_TODAY）へ追記され当日から採用される', () => {
    seedTodayRule();
    const g = createGoal(
      db,
      { name: '掃除習慣', practices: [], newConditions: [{ target: 'TIMELINE', label: '掃除', thresholdSeconds: 900 }], start: 'today' },
      NOW_TODAY,
    );
    expect(g.practices.map((p) => p.conditionKey)).toContain('timeline:掃除');
    // 当日ルールは DRAFT_TODAY になり、baseline(total_work)＋追加(timeline:掃除) を含む。
    const rs = getRuleSet(db, '2026-07-10')!;
    expect(rs.ruleSet.status).toBe('DRAFT_TODAY');
    const keys = rs.conditions.map((c) => c.condition_key).sort();
    expect(keys).toEqual(['timeline:掃除', 'total_work']);
  });

  it('削除は今日開始でも作成当日のみ可能', () => {
    seedTodayRule();
    const g = createGoal(db, { name: '今日から', practices: ['total_work'] }, NOW_TODAY);
    expect(deleteGoal(db, g.id, NOW_TODAY)).toBe(true);
  });
});

describe('目標作成時のインライン条件作成（newConditions・明日開始）', () => {
  /** 翌日ルールの condition_key → 閾値秒 のマップ。 */
  function ruleThresholds(dayKey: string): Map<string, number | null> {
    const rs = getRuleSet(db, dayKey);
    return new Map((rs?.conditions ?? []).map((c) => [c.condition_key, c.threshold_seconds]));
  }

  it('新規「掃除15分」を作成して採用でき、翌日ルールへ timeline:掃除（900秒）が追記される', () => {
    seedTomorrowRule();
    const g = createGoal(
      db,
      { name: '部屋をきれいにする', practices: [], newConditions: [{ target: 'TIMELINE', label: '掃除', thresholdSeconds: 900 }], start: 'tomorrow' },
      NOW_TODAY,
    );
    // 採用実践に timeline:掃除 が含まれる。
    expect(g.practices.map((p) => p.conditionKey)).toContain('timeline:掃除');
    const p = g.practices.find((x) => x.conditionKey === 'timeline:掃除')!;
    expect(p.target).toBe('TIMELINE');
    // 翌日ルールへ追記されている（900秒）。
    const th = ruleThresholds(START);
    expect(th.get('timeline:掃除')).toBe(900);
  });

  it('インライン作成は既存の翌日条件（total_work 等）を据え置きで保持する', () => {
    seedTomorrowRule();
    const before = ruleThresholds(START);
    createGoal(
      db,
      { name: 'x', practices: [], newConditions: [{ target: 'TIMELINE', label: '掃除', thresholdSeconds: 900 }], start: 'tomorrow' },
      NOW_TODAY,
    );
    const after = ruleThresholds(START);
    // 既存条件のキー・閾値は不変、TIMELINE 追記のみ。
    expect(after.get('total_work')).toBe(before.get('total_work'));
    expect(after.get('group:g-atcoder')).toBe(before.get('group:g-atcoder'));
    expect(after.has('timeline:掃除')).toBe(true);
  });

  it('既存条件を採用中の別目標を壊さず（GoalLockError なし）、閾値据え置きで理由要求も出ない', () => {
    seedTomorrowRule();
    // 別目標が total_work を採用中。
    createGoal(db, { name: '既存', practices: ['total_work'], start: 'tomorrow' }, NOW_TODAY);
    // インライン TIMELINE 追加は既存条件を据え置くので成功する。
    expect(() =>
      createGoal(
        db,
        { name: '新規習慣', practices: [], newConditions: [{ target: 'TIMELINE', label: '運動', thresholdSeconds: 1800 }], start: 'tomorrow' },
        NOW_TODAY,
      ),
    ).not.toThrow();
    // 閾値変更ログは発生していない（据え置き）。
    expect((db.prepare('SELECT COUNT(*) AS c FROM practice_threshold_change').get() as { c: number }).c).toBe(0);
  });

  it('TIMELINE 以外・label 空・分数0 は拒否され、目標もルールも作られない（rollback）', () => {
    seedTomorrowRule();
    // TIMELINE 以外。
    expect(() =>
      createGoal(
        db,
        { name: 'x', practices: [], newConditions: [{ target: 'TOTAL_WORK' as 'TIMELINE', label: 'a', thresholdSeconds: 60 }], start: 'tomorrow' },
        NOW_TODAY,
      ),
    ).toThrow(GoalPracticeError);
    // label 空。
    expect(() =>
      createGoal(db, { name: 'x', practices: [], newConditions: [{ target: 'TIMELINE', label: '  ', thresholdSeconds: 60 }], start: 'tomorrow' }, NOW_TODAY),
    ).toThrow(GoalPracticeError);
    // 分数0。
    expect(() =>
      createGoal(db, { name: 'x', practices: [], newConditions: [{ target: 'TIMELINE', label: '掃除', thresholdSeconds: 0 }], start: 'tomorrow' }, NOW_TODAY),
    ).toThrow(GoalPracticeError);
    // いずれも目標は作られない。
    expect(listGoals(db, NOW_TODAY).length).toBe(0);
    // 採用が失敗する経路（bogus キー同伴）でも、追記済み条件が rollback される。
    expect(() =>
      createGoal(
        db,
        {
          name: 'x',
          practices: ['group:does-not-exist'],
          newConditions: [{ target: 'TIMELINE', label: '掃除', thresholdSeconds: 900 }],
          start: 'tomorrow',
        },
        NOW_TODAY,
      ),
    ).toThrow(GoalPracticeError);
    expect(getRuleSet(db, START)!.conditions.some((c) => c.condition_key === 'timeline:掃除')).toBe(false);
    expect(listGoals(db, NOW_TODAY).length).toBe(0);
  });

  it('フォールバック継承の翌日でも materialize されて追記・採用が成功する', () => {
    // 当日(07-10)に明示ルールを作成 → 翌日(START=07-11)は明示ルールを持たずフォールバック継承。
    upsertFutureRuleSet(db, '2026-07-10', { conditions: [{ target: 'TOTAL_WORK', thresholdSeconds: 14400 }] }, NOW_TODAY);
    expect(getRuleSet(db, START)).toBeNull(); // 翌日は明示ルール無し（継承）。
    const g = createGoal(
      db,
      { name: '掃除習慣', practices: [], newConditions: [{ target: 'TIMELINE', label: '掃除', thresholdSeconds: 900 }], start: 'tomorrow' },
      NOW_TODAY,
    );
    expect(g.practices.map((p) => p.conditionKey)).toContain('timeline:掃除');
    // 継承内容(total_work)も materialize されて翌日へ明示化され、TIMELINE が追記される。
    const rs = getRuleSet(db, START)!;
    const keys = rs.conditions.map((c) => c.condition_key).sort();
    expect(keys).toEqual(['timeline:掃除', 'total_work']);
  });
});

describe('削除猶予（作成当日のみ・明日開始）', () => {
  it('作成当日は削除でき、実践・日記も CASCADE で消える', () => {
    seedTomorrowRule();
    const g = createGoal(db, { name: 'A', practices: ['total_work'], start: 'tomorrow' }, NOW_TODAY);
    expect(deleteGoal(db, g.id, NOW_TODAY)).toBe(true);
    expect(listGoals(db, NOW_TODAY).length).toBe(0);
  });

  it('翌日以降は削除できない', () => {
    seedTomorrowRule();
    const g = createGoal(db, { name: 'A', practices: ['total_work'], start: 'tomorrow' }, NOW_TODAY);
    expect(() => deleteGoal(db, g.id, NOW_NEXT)).toThrow(GoalDeleteWindowError);
  });
});

describe('目標日記（明日開始）', () => {
  it('進行中の日は保存でき、reflection_done を汚染しない', () => {
    seedTomorrowRule();
    const g = createGoal(db, { name: 'A', practices: ['total_work'], start: 'tomorrow' }, NOW_TODAY);
    // 進行中（today=2026-07-11 が start..end 内）で保存。
    saveJournal(db, g.id, START, '初日の日記', NOW_NEXT);
    expect(getJournal(db, g.id, START).content).toBe('初日の日記');
    // reflection_entry には一切書かれない。
    expect((db.prepare('SELECT COUNT(*) AS c FROM reflection_entry').get() as { c: number }).c).toBe(0);
  });

  it('完走後の日記書き込みは拒否される', () => {
    seedTomorrowRule();
    const g = createGoal(db, { name: 'A', practices: ['total_work'], start: 'tomorrow' }, NOW_TODAY);
    expect(() => saveJournal(db, g.id, START, 'x', NOW_COMPLETED)).toThrow(JournalNotWritableError);
  });
});

describe('目標日記の画像添付（明日開始）', () => {
  it('開始前・進行中・完走後いずれでも追加/一覧/取得/更新/削除できる（D4b: いつでも可）', () => {
    seedTomorrowRule();
    const g = createGoal(db, { name: 'A', practices: ['total_work'], start: 'tomorrow' }, NOW_TODAY);

    // 開始前（today=2026-07-10 < start）に Day1(START) へ追加できる。
    const a = addJournalImage(db, g.id, START, { dataUrl: dataUrl('image/png', [1, 2, 3]), caption: '台所' }, NOW_TODAY);
    // 進行中に追加できる。
    const b = addJournalImage(db, g.id, START, { dataUrl: dataUrl('image/jpeg', [4, 5]), caption: '机' }, NOW_NEXT);
    // 完走後に最終日(END) へ追加できる。
    const c = addJournalImage(db, g.id, END, { dataUrl: dataUrl('image/png', [6]), caption: '台所' }, NOW_COMPLETED);
    expect(a.sortOrder).toBe(0);
    expect(b.sortOrder).toBe(1); // 当日最大+1

    const list = listJournalImages(db, g.id, START);
    expect(list.map((x) => x.caption)).toEqual(['台所', '机']); // sort_order 昇順
    expect(list.every((x) => 'bytes' in x)).toBe(false); // バイトは含めない

    const bin = getJournalImageBytes(db, g.id, a.imageId);
    expect(bin.mime).toBe('image/png');
    expect(Buffer.from(bin.bytes).equals(Buffer.from([1, 2, 3]))).toBe(true);

    // 更新・削除も状態を問わない（完走後でも可）。
    updateJournalImageCaption(db, g.id, a.imageId, 'キッチン');
    expect(listJournalImages(db, g.id, START).find((x) => x.imageId === a.imageId)!.caption).toBe('キッチン');
    expect(deleteJournalImage(db, g.id, c.imageId)).toBe(true);
    expect(listJournalImages(db, g.id, END).length).toBe(0);
  });

  it('期間外の day_key は 400（JournalImageError）で拒否される', () => {
    seedTomorrowRule();
    const g = createGoal(db, { name: 'A', practices: ['total_work'], start: 'tomorrow' }, NOW_TODAY);
    // START=2026-07-11・END=2026-08-09。範囲外は拒否。
    expect(() => addJournalImage(db, g.id, '2026-07-10', { dataUrl: dataUrl() }, NOW_NEXT)).toThrow(JournalImageError);
    expect(() => addJournalImage(db, g.id, '2026-08-10', { dataUrl: dataUrl() }, NOW_COMPLETED)).toThrow(JournalImageError);
    expect(listJournalImages(db, g.id, '2026-07-10').length).toBe(0);
  });

  it('他目標の imageId は触れない（所有検証・404 相当）', () => {
    seedTomorrowRule();
    const g1 = createGoal(db, { name: 'A', practices: ['total_work'], start: 'tomorrow' }, NOW_TODAY);
    const g2 = createGoal(db, { name: 'B', practices: ['total_work'], start: 'tomorrow' }, NOW_TODAY);
    const img = addJournalImage(db, g1.id, START, { dataUrl: dataUrl(), caption: 'g1' }, NOW_NEXT);
    // g2 のスコープで g1 の画像は取得・更新・削除できない。
    expect(() => getJournalImageBytes(db, g2.id, img.imageId)).toThrow(JournalImageNotFoundError);
    expect(() => updateJournalImageCaption(db, g2.id, img.imageId, 'x')).toThrow(JournalImageNotFoundError);
    expect(() => deleteJournalImage(db, g2.id, img.imageId)).toThrow(JournalImageNotFoundError);
    // g1 の画像は無傷。
    expect(listJournalImages(db, g1.id, START)[0]!.caption).toBe('g1');
  });

  it('非画像 mime・上限超過・不正データは拒否される', () => {
    seedTomorrowRule();
    const g = createGoal(db, { name: 'A', practices: ['total_work'], start: 'tomorrow' }, NOW_TODAY);
    expect(() => addJournalImage(db, g.id, START, { dataUrl: dataUrl('text/plain', [1]) }, NOW_NEXT)).toThrow(JournalImageError);
    expect(() => addJournalImage(db, g.id, START, { dataUrl: 'not-a-data-url' }, NOW_NEXT)).toThrow(JournalImageError);
    const big = new Array(5 * 1024 * 1024 + 1).fill(0);
    expect(() => addJournalImage(db, g.id, START, { dataUrl: dataUrl('image/png', big) }, NOW_NEXT)).toThrow(JournalImageError);
    expect(listJournalImages(db, g.id, START).length).toBe(0);
  });

  it('本文が無い日でも画像だけ保存でき、goal_journal 行は作られない', () => {
    seedTomorrowRule();
    const g = createGoal(db, { name: 'A', practices: ['total_work'], start: 'tomorrow' }, NOW_TODAY);
    addJournalImage(db, g.id, START, { dataUrl: dataUrl(), caption: '' }, NOW_NEXT);
    expect(listJournalImages(db, g.id, START).length).toBe(1);
    // 本文（goal_journal）は空のまま・行も無い。
    expect(getJournal(db, g.id, START).content).toBe('');
    expect((db.prepare('SELECT COUNT(*) AS c FROM goal_journal WHERE goal_id = ?').get(g.id) as { c: number }).c).toBe(0);
  });
});

describe('完了レポート（明日開始）', () => {
  it('完走前は 409（GoalReportNotReadyError）', () => {
    seedTomorrowRule();
    const g = createGoal(db, { name: 'A', practices: ['total_work'], start: 'tomorrow' }, NOW_TODAY);
    expect(() => getGoalReport(db, g.id, NOW_TODAY)).toThrow(GoalReportNotReadyError);
  });

  it('欠測=未達成、達成日数=全実践 met の日数、閾値マーカー、日単位フォールバック', () => {
    seedTomorrowRule();
    const g = createGoal(db, { name: 'A', practices: ['total_work', 'group:g-atcoder'], start: 'tomorrow' }, NOW_TODAY);

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

  it('レポートに days[i].images（④用）と reportImages（③用・キャプション別最古/最新）が載る', () => {
    seedTomorrowRule();
    const g = createGoal(db, { name: 'A', practices: ['total_work'], start: 'tomorrow' }, NOW_TODAY);
    const MID = addDaysKey(START, 14); // Day15
    // Day1(START) に「台所」「机」、Day15 に「台所」、Day30(END) に「机」「台所」を添付。
    addJournalImage(db, g.id, START, { dataUrl: dataUrl('image/png', [1]), caption: '台所' }, NOW_NEXT);
    addJournalImage(db, g.id, START, { dataUrl: dataUrl('image/png', [2]), caption: '机' }, NOW_NEXT);
    addJournalImage(db, g.id, MID, { dataUrl: dataUrl('image/png', [5]), caption: '台所' }, NOW_NEXT);
    addJournalImage(db, g.id, END, { dataUrl: dataUrl('image/png', [3]), caption: '机' }, NOW_NEXT);
    addJournalImage(db, g.id, END, { dataUrl: dataUrl('image/png', [4]), caption: '台所' }, NOW_NEXT);

    const rep = getGoalReport(db, g.id, NOW_COMPLETED);

    // ④用: 各日の画像（添付順）。間の日は空配列。
    expect(rep.days[0]!.images.map((x) => x.caption)).toEqual(['台所', '机']);
    expect(rep.days[14]!.images.map((x) => x.caption)).toEqual(['台所']); // Day15
    expect(rep.days[29]!.images.map((x) => x.caption)).toEqual(['机', '台所']);
    expect(rep.days[1]!.images).toEqual([]);

    // ③用: reportImages はキャプション別に dayNumber 昇順で並ぶ（最古/最新を取れる）。
    const kitchen = rep.reportImages.filter((x) => x.caption === '台所');
    const desk = rep.reportImages.filter((x) => x.caption === '机');
    expect(kitchen.map((x) => x.dayNumber)).toEqual([1, 15, 30]); // 最古=Day1, 最新=Day30, 中間=Day15
    expect(desk.map((x) => x.dayNumber)).toEqual([1, 30]);
    expect(rep.reportImages.length).toBe(5);
  });

  it('TIMELINE 実践は①カレンダーに乗り、②時間推移（isTimeType）として扱われる', () => {
    upsertFutureRuleSet(
      db,
      START,
      { conditions: [{ target: 'TIMELINE', label: '運動', thresholdSeconds: 1800 }] },
      NOW_TODAY,
    );
    const g = createGoal(db, { name: '運動', practices: ['timeline:運動'], start: 'tomorrow' }, NOW_TODAY);
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
