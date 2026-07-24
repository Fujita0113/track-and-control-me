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
  type GoalPracticeTarget,
} from './goals.js';
import { createPlan, createCheck, submitPhoto, answerQuestion } from './goal-plan-check.js';
import { resolveIdentity } from './group-identity.js';

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
        { target: 'MANUAL_CHECK', label: '振り返り' },
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
  it('採用候補は翌日実効ルールから出て MANUAL_CHECK も含む', () => {
    seedTomorrowRule();
    const cands = adoptCandidates(db, NOW_TODAY, 'tomorrow');
    const keys = cands.map((c) => c.conditionKey).sort();
    expect(keys).toEqual(['group:g-atcoder', 'manual:振り返り', 'planning:reflection_done', 'total_work']);
    // 手動チェックはラベル由来の安定キー・非時間型（閾値なし・接頭辞なしのラベル表示）。
    const manual = cands.find((c) => c.conditionKey === 'manual:振り返り')!;
    expect(manual.target).toBe('MANUAL_CHECK');
    expect(manual.label).toBe('振り返り');
    expect(manual.thresholdSeconds).toBeNull();
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
    // 実在しない手動チェックキー（旧 index 形式）は候補外なので採用できない。
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

  it('TIMELINE / MANUAL_CHECK 条件は採用候補に含まれ、採用できる', () => {
    upsertFutureRuleSet(
      db,
      START,
      {
        conditions: [
          { target: 'TIMELINE', label: '運動', thresholdSeconds: 1800 },
          { target: 'MANUAL_CHECK', label: '筋トレ' },
        ],
      },
      NOW_TODAY,
    );
    const cands = adoptCandidates(db, NOW_TODAY, 'tomorrow');
    const tl = cands.find((c) => c.conditionKey === 'timeline:運動');
    expect(tl).toBeTruthy();
    expect(tl!.target).toBe('TIMELINE');
    expect(tl!.label).toBe('運動 30分以上'); // 「<カテゴリ> ◯分以上」・生キーは出さない
    const mc = cands.find((c) => c.conditionKey === 'manual:筋トレ');
    expect(mc).toBeTruthy();
    expect(mc!.target).toBe('MANUAL_CHECK');
    expect(mc!.label).toBe('筋トレ'); // 接頭辞なしのラベル表示
    // どちらも採用可能（安定キーで保存される）。
    const g = createGoal(
      db,
      { name: '運動習慣', practices: ['timeline:運動', 'manual:筋トレ'], start: 'tomorrow' },
      NOW_TODAY,
    );
    const byKey = new Map(g.practices.map((p) => [p.conditionKey, p]));
    expect(byKey.get('timeline:運動')!.target).toBe('TIMELINE');
    expect(byKey.get('manual:筋トレ')!.target).toBe('MANUAL_CHECK');
    expect(byKey.get('manual:筋トレ')!.label).toBe('筋トレ'); // ラベルスナップショット
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

  it('TOTAL_WORK をその場で作成して採用でき、開始日ルールへ total_work（14400秒）が追記される', () => {
    // 開始日ルールに total_work が無い状態（TIMELINE のみ）を作る。
    upsertFutureRuleSet(db, START, { conditions: [{ target: 'TIMELINE', label: '運動', thresholdSeconds: 1800 }] }, NOW_TODAY);
    const g = createGoal(
      db,
      { name: '総作業4h', practices: [], newConditions: [{ target: 'TOTAL_WORK', thresholdSeconds: 14400 }], start: 'tomorrow' },
      NOW_TODAY,
    );
    expect(g.practices.map((p) => p.conditionKey)).toContain('total_work');
    expect(ruleThresholds(START).get('total_work')).toBe(14400);
  });

  it('GROUP をその場で作成して採用でき、group:<identityId>（7200秒）が追記される', () => {
    upsertFutureRuleSet(db, START, { conditions: [{ target: 'TOTAL_WORK', thresholdSeconds: 14400 }] }, NOW_TODAY);
    // 既存 identity を1つ用意する（バリデーションが group_identity の存在を要求する）。
    const identityId = resolveIdentity(db, '読書', 'blue')!;
    const g = createGoal(
      db,
      { name: '読書2h', practices: [], newConditions: [{ target: 'GROUP', groupIdentityId: identityId, thresholdSeconds: 7200 }], start: 'tomorrow' },
      NOW_TODAY,
    );
    const key = `group:${identityId}`;
    expect(g.practices.map((p) => p.conditionKey)).toContain(key);
    const p = g.practices.find((x) => x.conditionKey === key)!;
    expect(p.target).toBe('GROUP');
    expect(ruleThresholds(START).get(key)).toBe(7200);
  });

  it('MANUAL_CHECK をその場で作成して採用でき、manual:<ラベル>（閾値なし）が追記される', () => {
    upsertFutureRuleSet(db, START, { conditions: [{ target: 'TOTAL_WORK', thresholdSeconds: 14400 }] }, NOW_TODAY);
    const g = createGoal(
      db,
      { name: '筋トレ習慣', practices: [], newConditions: [{ target: 'MANUAL_CHECK', label: '筋トレ' }], start: 'tomorrow' },
      NOW_TODAY,
    );
    expect(g.practices.map((p) => p.conditionKey)).toContain('manual:筋トレ');
    const p = g.practices.find((x) => x.conditionKey === 'manual:筋トレ')!;
    expect(p.target).toBe('MANUAL_CHECK');
    expect(p.label).toBe('筋トレ');
    // 非時間型なので閾値は無い。
    const rs = getRuleSet(db, START)!;
    expect(rs.conditions.find((c) => c.condition_key === 'manual:筋トレ')!.threshold_seconds).toBeNull();
  });

  it('PLANNING をその場で作成して採用でき、planning:<signalKey> が追記される', () => {
    upsertFutureRuleSet(db, START, { conditions: [{ target: 'TOTAL_WORK', thresholdSeconds: 14400 }] }, NOW_TODAY);
    const g = createGoal(
      db,
      { name: '計画習慣', practices: [], newConditions: [{ target: 'PLANNING', signalKey: 'reflection_done' }], start: 'tomorrow' },
      NOW_TODAY,
    );
    expect(g.practices.map((p) => p.conditionKey)).toContain('planning:reflection_done');
    expect(g.practices.find((x) => x.conditionKey === 'planning:reflection_done')!.target).toBe('PLANNING');
    expect(getRuleSet(db, START)!.conditions.some((c) => c.condition_key === 'planning:reflection_done')).toBe(true);
  });

  it('既存キーと重複する新規作成は重複追記されず既存採用へ寄る（singleton の total_work / planning）', () => {
    // 開始日ルールに total_work（14400秒）と planning:reflection_done が既存。
    seedTomorrowRule();
    const before = ruleThresholds(START);
    const g = createGoal(
      db,
      {
        name: '重複回避',
        practices: [],
        // total_work は閾値違いを送っても追記せず既存を採用（閾値変更ログも出ない）。
        newConditions: [
          { target: 'TOTAL_WORK', thresholdSeconds: 3600 },
          { target: 'PLANNING', signalKey: 'reflection_done' },
        ],
        start: 'tomorrow',
      },
      NOW_TODAY,
    );
    const keys = g.practices.map((p) => p.conditionKey);
    expect(keys).toContain('total_work');
    expect(keys).toContain('planning:reflection_done');
    // 既存 total_work の閾値は据え置き（重複追記されていない）。
    expect(ruleThresholds(START).get('total_work')).toBe(before.get('total_work'));
    // 条件は重複せず1本のまま。
    const rs = getRuleSet(db, START)!;
    expect(rs.conditions.filter((c) => c.condition_key === 'total_work').length).toBe(1);
    expect(rs.conditions.filter((c) => c.condition_key === 'planning:reflection_done').length).toBe(1);
    // 閾値変更ログは出ない（据え置き）。
    expect((db.prepare('SELECT COUNT(*) AS c FROM practice_threshold_change').get() as { c: number }).c).toBe(0);
  });

  it('label 空・分数0・GROUP 不正・未対応 target は拒否され、目標もルールも作られない（rollback）', () => {
    seedTomorrowRule();
    const timelineCount = () => getRuleSet(db, START)!.conditions.filter((c) => c.condition_key.startsWith('timeline:')).length;
    // 未対応 target。
    expect(() =>
      createGoal(
        db,
        { name: 'x', practices: [], newConditions: [{ target: 'BOGUS' as GoalPracticeTarget }], start: 'tomorrow' },
        NOW_TODAY,
      ),
    ).toThrow(GoalPracticeError);
    // GROUP の groupIdentityId が存在しない。
    expect(() =>
      createGoal(
        db,
        { name: 'x', practices: [], newConditions: [{ target: 'GROUP', groupIdentityId: 999999, thresholdSeconds: 3600 }], start: 'tomorrow' },
        NOW_TODAY,
      ),
    ).toThrow(GoalPracticeError);
    // label 空。
    expect(() =>
      createGoal(db, { name: 'x', practices: [], newConditions: [{ target: 'TIMELINE', label: '  ', thresholdSeconds: 60 }], start: 'tomorrow' }, NOW_TODAY),
    ).toThrow(GoalPracticeError);
    // MANUAL_CHECK label 空。
    expect(() =>
      createGoal(db, { name: 'x', practices: [], newConditions: [{ target: 'MANUAL_CHECK', label: '' }], start: 'tomorrow' }, NOW_TODAY),
    ).toThrow(GoalPracticeError);
    // 分数0。
    expect(() =>
      createGoal(db, { name: 'x', practices: [], newConditions: [{ target: 'TIMELINE', label: '掃除', thresholdSeconds: 0 }], start: 'tomorrow' }, NOW_TODAY),
    ).toThrow(GoalPracticeError);
    // いずれも目標は作られず、TIMELINE も追記されない。
    expect(listGoals(db, NOW_TODAY).length).toBe(0);
    expect(timelineCount()).toBe(0);
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

  it('MANUAL_CHECK 実践は①カレンダーに乗り、②時間推移からは除外される（非時間型）', () => {
    upsertFutureRuleSet(
      db,
      START,
      { conditions: [{ target: 'MANUAL_CHECK', label: '筋トレ' }] },
      NOW_TODAY,
    );
    const g = createGoal(db, { name: '筋トレ習慣', practices: ['manual:筋トレ'], start: 'tomorrow' }, NOW_TODAY);
    // 採用時に target='MANUAL_CHECK'・ラベルスナップショット「筋トレ」で保存される。
    const gp = db
      .prepare('SELECT condition_key, target, label_snapshot FROM goal_practice WHERE goal_id = ?')
      .get(g.id) as { condition_key: string; target: string; label_snapshot: string };
    expect(gp.condition_key).toBe('manual:筋トレ');
    expect(gp.target).toBe('MANUAL_CHECK');
    expect(gp.label_snapshot).toBe('筋トレ');

    seedEval('2026-07-11', [
      { conditionKey: 'manual:筋トレ', target: 'MANUAL_CHECK', met: true, actualSeconds: null, thresholdSeconds: null },
    ]);
    const rep = getGoalReport(db, g.id, NOW_COMPLETED);
    const p = rep.practices.find((x) => x.conditionKey === 'manual:筋トレ')!;
    expect(p.isTimeType).toBe(false); // ② 時間推移からは除外
    expect(p.label).toBe('筋トレ'); // ラベルスナップショット
    expect(p.cells[0]!.met).toBe(true); // ① Day1 達成（カレンダーに乗る）
    expect(rep.hasTimeType).toBe(false);
  });
});

describe('走行中プレビュー（レポートの鍵を外す・spec: goal-report / design D6）', () => {
  // START=2026-07-11 の目標で Day12 = 2026-07-22。
  const NOW_DAY12 = jst(2026, 7, 22, 12, 0);
  const DAY12_KEY = '2026-07-22';

  /** 総作業時間だけを採用した進行中の目標を作り、Day1..Day12 の評価行を met で埋める。 */
  function seedRunningGoal(): number {
    seedTomorrowRule();
    const g = createGoal(db, { name: 'A', practices: ['total_work'], start: 'tomorrow' }, NOW_TODAY);
    for (let i = 0; i < 12; i++) {
      seedEval(addDaysKey(START, i), [
        { conditionKey: 'total_work', target: 'TOTAL_WORK', met: true, actualSeconds: 15000, thresholdSeconds: 14400 },
      ]);
    }
    return g.id;
  }

  it('7.1 進行中でもレポートが返る（Day 12/30 の姿）', () => {
    const id = seedRunningGoal();
    const rep = getGoalReport(db, id, NOW_DAY12);
    expect(rep.goal.status).toBe('active');
    expect(rep.goal.dayNumber).toBe(12);
    expect(rep.goal.dayCount).toBe(30);
  });

  it('7.1 開始前は従来どおり拒否される', () => {
    seedTomorrowRule();
    const g = createGoal(db, { name: 'A', practices: ['total_work'], start: 'tomorrow' }, NOW_TODAY);
    expect(() => getGoalReport(db, g.id, NOW_TODAY)).toThrow(GoalReportNotReadyError);
  });

  it('7.2 未到来（Day13〜30）は空白＝future で、未達成の黒星にならない', () => {
    const id = seedRunningGoal();
    const cells = getGoalReport(db, id, NOW_DAY12).practices[0]!.cells;

    // Day1〜12 は事実どおり（到来済み・達成）。
    for (const c of cells.slice(0, 12)) {
      expect(c.future).toBe(false);
      expect(c.met).toBe(true);
    }
    // Day13〜30 は未到来＝空白（met=false だが future=true で区別される）。
    for (const c of cells.slice(12)) {
      expect(c.future).toBe(true);
      expect(c.met).toBe(false);
    }
    expect(cells.filter((c) => c.future)).toHaveLength(18);
  });

  it('7.2 欠測（到来済みで評価行が無い日）は未到来と区別され、未達成のまま', () => {
    seedTomorrowRule();
    const g = createGoal(db, { name: 'A', practices: ['total_work'], start: 'tomorrow' }, NOW_TODAY);
    // Day1 だけ評価行あり。Day2〜12 は欠測（サーバー停止日）。
    seedEval(START, [
      { conditionKey: 'total_work', target: 'TOTAL_WORK', met: true, actualSeconds: 15000, thresholdSeconds: 14400 },
    ]);
    const cells = getGoalReport(db, g.id, NOW_DAY12).practices[0]!.cells;
    const day5 = cells[4]!;
    expect(day5).toMatchObject({ met: false, future: false }); // 欠測＝未達成（美化しない）。
    expect(cells[12]).toMatchObject({ met: false, future: true }); // 未到来＝空白。
  });

  it('7.2 完走後は未到来が1日も無い', () => {
    const id = seedRunningGoal();
    const cells = getGoalReport(db, id, NOW_COMPLETED).practices[0]!.cells;
    expect(cells.every((c) => c.future === false)).toBe(true);
    expect(cells).toHaveLength(30);
  });

  it('ヘッダの達成日数は現時点までを数える（未到来は数えない）', () => {
    const id = seedRunningGoal();
    expect(getGoalReport(db, id, NOW_DAY12).goal.achievedDays).toBe(12);
    expect(getGoalReport(db, id, NOW_DAY12).goal.elapsedDays).toBe(12);
    // 完走後も達成日数は同じ（Day13 以降は評価行が無い＝未達成）。
    expect(getGoalReport(db, id, NOW_COMPLETED).goal.achievedDays).toBe(12);
  });

  it('7.3 進行中の After は「現時点で最も新しい記録のある日」', () => {
    const id = seedRunningGoal();
    // Day3（07-13）に日記、Day8（07-18）に画像。Day9 以降は記録なし。
    saveJournal(db, id, '2026-07-13', 'Day3 の日記', jst(2026, 7, 13, 12, 0));
    addJournalImage(db, id, '2026-07-18', { dataUrl: dataUrl(), caption: '前髪・正面' }, jst(2026, 7, 18, 12, 0));

    const rep = getGoalReport(db, id, NOW_DAY12);
    expect(rep.goal.afterDayNumber).toBe(8); // 画像のある Day8 が最新の記録。
  });

  it('7.3 完走後の After は最終日（Day30）', () => {
    const id = seedRunningGoal();
    expect(getGoalReport(db, id, NOW_COMPLETED).goal.afterDayNumber).toBe(30);
  });

  it('7.3 最終日写真の CTA は完走後のみ（進行中は出さない）', () => {
    const id = seedRunningGoal();
    expect(getGoalReport(db, id, NOW_DAY12).goal.showFinalPhotoCta).toBe(false);
    expect(getGoalReport(db, id, NOW_COMPLETED).goal.showFinalPhotoCta).toBe(true);
  });

  it('7.5 記録が1つも無い進行中でも壊れない（部分データ）', () => {
    seedTomorrowRule();
    const g = createGoal(db, { name: 'A', practices: ['total_work'], start: 'tomorrow' }, NOW_TODAY);
    // 評価行・日記・画像・Plan がすべて無い Day1 時点。
    const rep = getGoalReport(db, g.id, jst(2026, 7, 11, 12, 0));
    expect(rep.goal.achievedDays).toBe(0);
    expect(rep.goal.dayNumber).toBe(1);
    expect(rep.goal.afterDayNumber).toBe(1); // 記録が無ければ現在の Day に落ちる。
    expect(rep.days).toHaveLength(30);
    expect(rep.reportImages).toEqual([]);
    expect(rep.chronicle.plans).toEqual([]);
    expect(rep.practices[0]!.cells.filter((c) => c.future)).toHaveLength(29);
  });

  it('7.5 時間型実践が0個でも壊れない（②が描けない構成）', () => {
    seedTomorrowRule();
    const g = createGoal(db, { name: 'A', practices: ['planning:reflection_done'], start: 'tomorrow' }, NOW_TODAY);
    const rep = getGoalReport(db, g.id, NOW_DAY12);
    expect(rep.hasTimeType).toBe(false);
    expect(rep.practices).toHaveLength(1);
  });

  it('7.4 ⑤沿革がレポートに含まれる（日記は含まない）', () => {
    const id = seedRunningGoal();
    saveJournal(db, id, '2026-07-13', '日記の本文はここに', jst(2026, 7, 13, 12, 0));
    const plan = createPlan(db, id, { body: 'シャンプーを変える' }, jst(2026, 7, 13, 12, 0));
    const check = createCheck(
      db,
      plan.id,
      { kind: 'question', questionText: '使用感は？', schedule: 'single', startInDays: 1 },
      jst(2026, 7, 13, 12, 0),
    );
    answerQuestion(db, check.id, '2026-07-14', { answerText: '泡立ちは良い' }, jst(2026, 7, 14, 12, 0));

    const rep = getGoalReport(db, id, NOW_DAY12);
    expect(rep.chronicle.goalId).toBe(id);
    expect(rep.chronicle.plans).toHaveLength(1);
    expect(rep.chronicle.plans[0]!.body).toBe('シャンプーを変える');
    expect(rep.chronicle.plans[0]!.checks[0]!.results[0]!.answerText).toBe('泡立ちは良い');
    // ④日記リーダーには日記が載るが、⑤沿革には載らない。
    expect(JSON.stringify(rep.chronicle)).not.toContain('日記の本文はここに');
    expect(rep.days[2]!.text).toBe('日記の本文はここに');
  });

  it('7.4 写真Check の提出画像は③の Before/After へ流入する（先指定キャプションでグループ化）', () => {
    const id = seedRunningGoal();
    const plan = createPlan(db, id, { body: 'シャンプーを変える' }, jst(2026, 7, 13, 12, 0));
    const check = createCheck(
      db,
      plan.id,
      { kind: 'photo', caption: '前髪・正面', schedule: 'range', startInDays: 1, spanDays: 3 },
      jst(2026, 7, 13, 12, 0),
    );
    submitPhoto(db, check.id, '2026-07-14', { dataUrl: dataUrl() }, jst(2026, 7, 14, 12, 0));
    submitPhoto(db, check.id, '2026-07-16', { dataUrl: dataUrl() }, jst(2026, 7, 16, 12, 0));

    const imgs = getGoalReport(db, id, NOW_DAY12).reportImages.filter((i) => i.caption === '前髪・正面');
    expect(imgs.map((i) => i.dayNumber)).toEqual([4, 6]); // Day4（Before）→ Day6（After）の時系列。
  });
});
