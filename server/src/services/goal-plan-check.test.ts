import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../db/index.js';
import {
  createPlan,
  createCheck,
  listPlans,
  withdrawPlan,
  cancelCheck,
  updateCheckCaption,
  submitPhoto,
  answerQuestion,
  getChronicle,
  listDueChecks,
  PlanCheckError,
  CheckImmutableError,
} from './goal-plan-check.js';
import { saveJournal, GoalNotFoundError } from './goals.js';
import { zonedTimeToEpoch } from '../aggregation/index.js';

/**
 * Plan / Check のサービス層（spec: goal-plan-check / goal-chronicle）。
 * 「今日」は tz 正午の epoch ms を渡して固定する（Date.now() 非依存）。
 */

const TODAY = '2026-07-15';
const START = '2026-07-15';
const END = '2026-08-13'; // START + 29

/** day_key の正午（Asia/Tokyo）を epoch ms へ。 */
function noon(dayKey: string): number {
  const [y, m, d] = dayKey.split('-').map(Number);
  return zonedTimeToEpoch(y!, m!, d!, 12, 0, 0, 'Asia/Tokyo');
}

let db: DB;
let goalId: number;

/** 進行中の目標（Day1 = 2026-07-15）を1つ作る。 */
beforeEach(() => {
  db = openDb(':memory:');
  goalId = db
    .prepare('INSERT INTO goal (name, purpose, start_day, end_day, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('髪質を改善する', '髪で悩まない', START, END, noon(TODAY)).lastInsertRowid as number;
});

const PLAN_BODY = 'ボリュームアップシャンプーを使えば髪質が良くなるのではないだろうか';
const PHOTO_SINGLE = { kind: 'photo', caption: '前髪・正面', schedule: 'single', startInDays: 3 } as const;
const QUESTION_RANGE = {
  kind: 'question',
  questionText: 'ボリュームアップシャンプーの使用感はどうだった？',
  schedule: 'range',
  startInDays: 3,
  spanDays: 7,
} as const;
/** 1x1 の最小 PNG（addJournalImage の mime / 非空検証を通す）。 */
const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('3.1 Plan 作成', () => {
  it('進行中の目標に Plan を書ける（当日の day_key が付く）', () => {
    const p = createPlan(db, goalId, { body: PLAN_BODY }, noon(TODAY));
    expect(p).toMatchObject({ goalId, dayKey: TODAY, body: PLAN_BODY, status: 'active' });
    expect(p.checks).toEqual([]);
  });

  it('本文が空の Plan は作れない', () => {
    expect(() => createPlan(db, goalId, { body: '   ' }, noon(TODAY))).toThrow(PlanCheckError);
  });

  it('完走後の目標には Plan を書けない', () => {
    expect(() => createPlan(db, goalId, { body: PLAN_BODY }, noon('2026-08-14'))).toThrow(/完走/);
  });

  it('開始前の目標には Plan を書けない', () => {
    const upcoming = db
      .prepare('INSERT INTO goal (name, purpose, start_day, end_day, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('未来の目標', '', '2026-09-01', '2026-09-30', noon(TODAY)).lastInsertRowid as number;
    expect(() => createPlan(db, upcoming, { body: PLAN_BODY }, noon(TODAY))).toThrow(/開始前/);
  });

  it('存在しない目標は 404 相当', () => {
    expect(() => createPlan(db, 999, { body: PLAN_BODY }, noon(TODAY))).toThrow(GoalNotFoundError);
  });

  it('3.5 Check なしの Plan を作れる（方針だけ書く）', () => {
    const p = createPlan(db, goalId, { body: 'ブログはやめる。反応が薄いから' }, noon(TODAY));
    expect(listPlans(db, goalId).find((x) => x.id === p.id)!.checks).toEqual([]);
  });
});

describe('3.2 / 3.3 Check 作成（種類 × いつ の2軸）', () => {
  let planId: number;
  beforeEach(() => {
    planId = createPlan(db, goalId, { body: PLAN_BODY }, noon(TODAY)).id;
  });

  it('📷×単発・📷×範囲・💬×単発・💬×範囲 の全4通りが作れる', () => {
    const combos = [
      { kind: 'photo', caption: '前髪・正面', schedule: 'single', startInDays: 3 },
      { kind: 'photo', caption: '前髪・正面', schedule: 'range', startInDays: 3, spanDays: 7 },
      { kind: 'question', questionText: '使用感は？', schedule: 'single', startInDays: 3 },
      { kind: 'question', questionText: '使用感は？', schedule: 'range', startInDays: 3, spanDays: 7 },
    ];
    for (const c of combos) {
      const made = createCheck(db, planId, c, noon(TODAY));
      expect(made).toMatchObject({ kind: c.kind, schedule: c.schedule });
    }
    expect(listPlans(db, goalId)[0]!.checks).toHaveLength(4);
  });

  it('相対（3日後）と絶対（7/18）のどちらの入力も同じ固定 start_day_key へ解決する', () => {
    const rel = createCheck(db, planId, PHOTO_SINGLE, noon(TODAY));
    const abs = createCheck(
      db,
      planId,
      { kind: 'photo', caption: '前髪・横', schedule: 'single', startDayKey: '2026-07-18' },
      noon(TODAY),
    );
    expect(rel.startDayKey).toBe('2026-07-18');
    expect(abs.startDayKey).toBe('2026-07-18');
  });

  it('範囲Check は span_days を持ち、単発は null', () => {
    expect(createCheck(db, planId, QUESTION_RANGE, noon(TODAY))).toMatchObject({ spanDays: 7 });
    expect(createCheck(db, planId, PHOTO_SINGLE, noon(TODAY))).toMatchObject({ spanDays: null });
  });

  it('photo はキャプション非空・question は質問文非空', () => {
    expect(() =>
      createCheck(db, planId, { kind: 'photo', caption: '  ', schedule: 'single', startInDays: 3 }, noon(TODAY)),
    ).toThrow(/キャプション/);
    expect(() =>
      createCheck(db, planId, { kind: 'question', questionText: '', schedule: 'single', startInDays: 3 }, noon(TODAY)),
    ).toThrow(/質問文/);
  });

  it('範囲は span_days >= 2 必須', () => {
    for (const span of [undefined, 1]) {
      expect(() =>
        createCheck(db, planId, { kind: 'photo', caption: 'x', schedule: 'range', startInDays: 3, spanDays: span }, noon(TODAY)),
      ).toThrow(/2日以上/);
    }
  });

  it('場所メモ・時刻メモを持てる（判定には使わない・D8）', () => {
    const c = createCheck(
      db,
      planId,
      { ...PHOTO_SINGLE, placeNote: '洗面所', timeNote: '朝' },
      noon(TODAY),
    );
    expect(c).toMatchObject({ placeNote: '洗面所', timeNote: '朝' });
    // メモに反する提出（別日・別時刻）でも達成として扱われる＝判定に使っていない。
    const r = submitPhoto(db, c.id, '2026-07-18', { dataUrl: PNG_DATA_URL }, noon('2026-07-18'));
    expect(r.imageId).not.toBeNull();
  });

  it('過去の日・目標期間より後には仕掛けられない', () => {
    expect(() =>
      createCheck(db, planId, { kind: 'photo', caption: 'x', schedule: 'single', startDayKey: '2026-07-14' }, noon(TODAY)),
    ).toThrow(/過去/);
    expect(() =>
      createCheck(db, planId, { kind: 'photo', caption: 'x', schedule: 'single', startDayKey: '2026-09-01' }, noon(TODAY)),
    ).toThrow(/目標期間/);
  });

  it('取り下げた Plan には Check を足せない', () => {
    withdrawPlan(db, planId, { reason: 'やめた' });
    expect(() => createCheck(db, planId, PHOTO_SINGLE, noon(TODAY))).toThrow(/取り下げ/);
  });
});

describe('3.4 写真Check のキャプションは作成後変更不可', () => {
  it('変更しようとすると拒否される', () => {
    const planId = createPlan(db, goalId, { body: PLAN_BODY }, noon(TODAY)).id;
    const c = createCheck(db, planId, PHOTO_SINGLE, noon(TODAY));
    expect(() => updateCheckCaption(db, c.id, '別のキャプション')).toThrow(CheckImmutableError);
    // 値は変わっていない。
    expect(listPlans(db, goalId)[0]!.checks[0]!.caption).toBe('前髪・正面');
  });
});

describe('3.6 理由つき取り下げ', () => {
  let planId: number;
  beforeEach(() => {
    planId = createPlan(db, goalId, { body: PLAN_BODY }, noon(TODAY)).id;
  });

  it('理由つきで Check を取り下げると cancelled になり、理由が残る', () => {
    const c = createCheck(db, planId, PHOTO_SINGLE, noon(TODAY));
    const out = cancelCheck(db, c.id, { reason: 'シャンプーが肌に合わず返品した' });
    expect(out).toMatchObject({ status: 'cancelled', cancelReason: 'シャンプーが肌に合わず返品した' });
  });

  it('理由が空の取り下げは拒否され、状態は変わらない', () => {
    const c = createCheck(db, planId, PHOTO_SINGLE, noon(TODAY));
    expect(() => cancelCheck(db, c.id, { reason: '  ' })).toThrow(/理由/);
    expect(listPlans(db, goalId)[0]!.checks[0]!.status).toBe('active');
  });

  it('達成済み（単発で提出済み）の Check は取り下げられない', () => {
    const c = createCheck(db, planId, PHOTO_SINGLE, noon(TODAY));
    submitPhoto(db, c.id, '2026-07-18', { dataUrl: PNG_DATA_URL }, noon('2026-07-18'));
    expect(() => cancelCheck(db, c.id, { reason: 'やっぱやめた' })).toThrow(/達成済み/);
  });

  it('範囲Check は途中まで提出していても取り下げられる（「3日で飽きた」）', () => {
    const c = createCheck(db, planId, QUESTION_RANGE, noon(TODAY));
    answerQuestion(db, c.id, '2026-07-18', { answerText: '泡立ちは良い' }, noon('2026-07-18'));
    const out = cancelCheck(db, c.id, { reason: '続かなかった。3日で飽きた' });
    expect(out.status).toBe('cancelled');
    expect(out.results).toHaveLength(1); // 提出済みの事実は消えない。
  });

  it('Plan を取り下げるとぶら下がる未達 Check がすべて cancelled になる', () => {
    const c1 = createCheck(db, planId, PHOTO_SINGLE, noon(TODAY));
    const c2 = createCheck(db, planId, QUESTION_RANGE, noon(TODAY));
    const p = withdrawPlan(db, planId, { reason: '効果が無かった' });
    expect(p).toMatchObject({ status: 'withdrawn', withdrawReason: '効果が無かった' });
    const byId = new Map(p.checks.map((c) => [c.id, c]));
    expect(byId.get(c1.id)).toMatchObject({ status: 'cancelled', cancelReason: '効果が無かった' });
    expect(byId.get(c2.id)).toMatchObject({ status: 'cancelled', cancelReason: '効果が無かった' });
  });

  it('Plan 取り下げでも達成済みの単発Check は事実として残す', () => {
    const done = createCheck(db, planId, PHOTO_SINGLE, noon(TODAY));
    submitPhoto(db, done.id, '2026-07-18', { dataUrl: PNG_DATA_URL }, noon('2026-07-18'));
    const p = withdrawPlan(db, planId, { reason: '方針転換' });
    expect(p.checks.find((c) => c.id === done.id)!.status).toBe('active');
  });

  it('理由が空の Plan 取り下げは拒否される', () => {
    expect(() => withdrawPlan(db, planId, { reason: '' })).toThrow(/理由/);
    expect(listPlans(db, goalId)[0]!.status).toBe('active');
  });
});

describe('回答（写真提出・質問回答）', () => {
  let planId: number;
  beforeEach(() => {
    planId = createPlan(db, goalId, { body: PLAN_BODY }, noon(TODAY)).id;
  });

  it('写真は先指定キャプションで goal_journal_image へ保存され image_id が result に載る', () => {
    const c = createCheck(db, planId, PHOTO_SINGLE, noon(TODAY));
    const r = submitPhoto(db, c.id, '2026-07-18', { dataUrl: PNG_DATA_URL }, noon('2026-07-18'));
    expect(r.imageId).toBeTypeOf('number');
    const img = db
      .prepare('SELECT caption, day_key, goal_id FROM goal_journal_image WHERE id = ?')
      .get(r.imageId!) as { caption: string; day_key: string; goal_id: number };
    expect(img).toMatchObject({ caption: '前髪・正面', day_key: '2026-07-18', goal_id: goalId });
  });

  it('空の答えは受け付けない（Check は未達のまま）', () => {
    const c = createCheck(db, planId, QUESTION_RANGE, noon(TODAY));
    expect(() => answerQuestion(db, c.id, '2026-07-18', { answerText: '   ' }, noon('2026-07-18'))).toThrow(/答え/);
    expect(listDueChecks(db, '2026-07-18').map((d) => d.checkId)).toContain(c.id);
  });

  it('開始日前には回答できない', () => {
    const c = createCheck(db, planId, PHOTO_SINGLE, noon(TODAY));
    expect(() => submitPhoto(db, c.id, TODAY, { dataUrl: PNG_DATA_URL }, noon(TODAY))).toThrow(/始まって/);
  });

  it('同じ日に二重回答はできない', () => {
    const c = createCheck(db, planId, QUESTION_RANGE, noon(TODAY));
    answerQuestion(db, c.id, '2026-07-18', { answerText: '泡立ちは良い' }, noon('2026-07-18'));
    expect(() => answerQuestion(db, c.id, '2026-07-18', { answerText: '二度目' }, noon('2026-07-18'))).toThrow(/既に回答/);
  });

  it('範囲Check の期間を過ぎた日は後から埋められない（その日の姿は再現不能）', () => {
    const c = createCheck(db, planId, QUESTION_RANGE, noon(TODAY)); // 7/18〜7/24
    expect(() => answerQuestion(db, c.id, '2026-07-25', { answerText: '後から' }, noon('2026-07-25'))).toThrow(/期間/);
  });

  it('取り下げた Check には回答できない', () => {
    const c = createCheck(db, planId, PHOTO_SINGLE, noon(TODAY));
    cancelCheck(db, c.id, { reason: 'やめた' });
    expect(() => submitPhoto(db, c.id, '2026-07-18', { dataUrl: PNG_DATA_URL }, noon('2026-07-18'))).toThrow(/取り下げ/);
  });

  it('種類の取り違え（写真Check に文章回答など）は拒否される', () => {
    const photo = createCheck(db, planId, PHOTO_SINGLE, noon(TODAY));
    const question = createCheck(db, planId, QUESTION_RANGE, noon(TODAY));
    expect(() => answerQuestion(db, photo.id, '2026-07-18', { answerText: 'x' }, noon('2026-07-18'))).toThrow();
    expect(() => submitPhoto(db, question.id, '2026-07-18', { dataUrl: PNG_DATA_URL }, noon('2026-07-18'))).toThrow();
  });
});

describe('8.4 その日に回答すべき Check', () => {
  it('開始日前は出ず、開始日から出て、回答すると消える', () => {
    const planId = createPlan(db, goalId, { body: PLAN_BODY }, noon(TODAY)).id;
    const c = createCheck(db, planId, PHOTO_SINGLE, noon(TODAY)); // 7/18 単発
    expect(listDueChecks(db, '2026-07-17')).toEqual([]);
    const due = listDueChecks(db, '2026-07-18');
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({
      checkId: c.id,
      goalName: '髪質を改善する',
      planBody: PLAN_BODY,
      label: '前髪・正面',
      kind: 'photo',
      rangeDayNumber: null,
    });
    submitPhoto(db, c.id, '2026-07-18', { dataUrl: PNG_DATA_URL }, noon('2026-07-18'));
    expect(listDueChecks(db, '2026-07-18')).toEqual([]);
  });

  it('範囲Check は N日中の何日目かを返し、期間を過ぎると消える', () => {
    const planId = createPlan(db, goalId, { body: PLAN_BODY }, noon(TODAY)).id;
    createCheck(db, planId, QUESTION_RANGE, noon(TODAY)); // 7/18〜7/24
    expect(listDueChecks(db, '2026-07-18')[0]).toMatchObject({ rangeDayNumber: 1, spanDays: 7 });
    expect(listDueChecks(db, '2026-07-24')[0]).toMatchObject({ rangeDayNumber: 7 });
    expect(listDueChecks(db, '2026-07-25')).toEqual([]);
  });

  it('未達の単発Check は翌日以降も出続ける（繰り越し）', () => {
    const planId = createPlan(db, goalId, { body: PLAN_BODY }, noon(TODAY)).id;
    createCheck(db, planId, PHOTO_SINGLE, noon(TODAY));
    for (const d of ['2026-07-18', '2026-07-19', '2026-07-30']) expect(listDueChecks(db, d)).toHaveLength(1);
  });

  it('取り下げると出なくなる', () => {
    const planId = createPlan(db, goalId, { body: PLAN_BODY }, noon(TODAY)).id;
    const c = createCheck(db, planId, PHOTO_SINGLE, noon(TODAY));
    cancelCheck(db, c.id, { reason: '返品した' });
    expect(listDueChecks(db, '2026-07-18')).toEqual([]);
  });
});

describe('6. 沿革（goal-chronicle）', () => {
  it('6.1 Plan は day_key 昇順・同日内は記録順で、Check が入れ子に並ぶ', () => {
    const p1 = createPlan(db, goalId, { body: '1つ目' }, noon('2026-07-15'));
    const p2 = createPlan(db, goalId, { body: '2つ目（同日・後）' }, noon('2026-07-15'));
    const p3 = createPlan(db, goalId, { body: '3つ目（翌日）' }, noon('2026-07-16'));
    createCheck(db, p1.id, PHOTO_SINGLE, noon('2026-07-15'));
    createCheck(db, p1.id, QUESTION_RANGE, noon('2026-07-15'));

    const c = getChronicle(db, goalId);
    expect(c.plans.map((p) => p.id)).toEqual([p1.id, p2.id, p3.id]);
    expect(c.plans[0]!.checks.map((x) => x.kind)).toEqual(['photo', 'question']);
    // 2回開いても同じ並び（決定的）。
    expect(getChronicle(db, goalId)).toEqual(c);
  });

  it('6.2 日記は沿革に載らない（内容が似ていても）', () => {
    saveJournal(db, goalId, TODAY, '泡立ちがいい感じ', noon(TODAY));
    const planId = createPlan(db, goalId, { body: PLAN_BODY }, noon(TODAY)).id;
    const c = createCheck(db, planId, QUESTION_RANGE, noon(TODAY));
    answerQuestion(db, c.id, '2026-07-18', { answerText: '泡立ちは良い' }, noon('2026-07-18'));

    const chronicle = getChronicle(db, goalId);
    const json = JSON.stringify(chronicle);
    expect(json).toContain('泡立ちは良い'); // 質問の答えは載る。
    expect(json).not.toContain('泡立ちがいい感じ'); // 日記本文は載らない。
  });

  it('6.3 取り下げた Plan / Check は理由つきで残る', () => {
    const planId = createPlan(db, goalId, { body: '頭皮マッサージを毎日やる' }, noon(TODAY)).id;
    createCheck(db, planId, QUESTION_RANGE, noon(TODAY));
    withdrawPlan(db, planId, { reason: '続かなかった。3日で飽きた' });

    const p = getChronicle(db, goalId).plans[0]!;
    expect(p).toMatchObject({ status: 'withdrawn', withdrawReason: '続かなかった。3日で飽きた' });
    expect(p.checks[0]).toMatchObject({ status: 'cancelled', cancelReason: '続かなかった。3日で飽きた' });
  });

  it('6.4 範囲Check は「N日中M日提出」に相当する事実を返す', () => {
    const planId = createPlan(db, goalId, { body: PLAN_BODY }, noon(TODAY)).id;
    const c = createCheck(db, planId, QUESTION_RANGE, noon(TODAY)); // 7日間
    for (const d of ['2026-07-18', '2026-07-19', '2026-07-21', '2026-07-22', '2026-07-24'])
      answerQuestion(db, c.id, d, { answerText: `${d} の答え` }, noon(d));

    const view = getChronicle(db, goalId).plans[0]!.checks[0]!;
    expect(view.spanDays).toBe(7); // N
    expect(view.results).toHaveLength(5); // M（7日中5日提出）
    expect(view.results.map((r) => r.dayKey)).toEqual([
      '2026-07-18',
      '2026-07-19',
      '2026-07-21',
      '2026-07-22',
      '2026-07-24',
    ]); // 提出日は時系列で並ぶ（サボった 7/20・7/23 は美化も負債化もしない）。
  });

  it('存在しない目標の沿革は 404 相当', () => {
    expect(() => getChronicle(db, 999)).toThrow(GoalNotFoundError);
  });
});
