import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { openDb, type DB } from '../db/index.js';
import { registerApiRoutes } from './index.js';
import { todayKey } from '../services/summary.js';
import { addDaysKey } from '../services/goals.js';

/**
 * 目標日記の画像 API（tasks 3.5）: 追加 → 一覧 → バイナリ取得 → キャプション更新 → 削除の一巡と、
 * 完走後の追加拒否（409）。API は実時刻（Date.now）で進行中判定するため、goal 行を「今日」基準で直接作る。
 */

const PNG_DATA_URL = `data:image/png;base64,${Buffer.from([1, 2, 3]).toString('base64')}`;

let app: FastifyInstance;
let db: DB;

beforeEach(async () => {
  db = openDb(':memory:');
  app = Fastify();
  await registerApiRoutes(app, { db, runPipeline: () => {} });
  await app.ready();
});
afterEach(async () => {
  await app.close();
  db.close();
});

/** 指定の開始/終了日で goal 行を作り、id を返す。 */
function insertGoal(startDay: string, endDay: string): number {
  return db
    .prepare('INSERT INTO goal (name, purpose, start_day, end_day, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('画像目標', '', startDay, endDay, Date.now()).lastInsertRowid as number;
}

describe('画像 API の一巡（進行中）', () => {
  it('追加 → 一覧 → バイナリ取得 → キャプション更新 → 削除', async () => {
    const today = todayKey(db, Date.now());
    const goalId = insertGoal(today, addDaysKey(today, 29)); // 今日を含む＝進行中。

    // 追加。
    const add = await app.inject({
      method: 'POST',
      url: `/api/goals/${goalId}/journal/${today}/images`,
      payload: { dataUrl: PNG_DATA_URL, caption: '台所' },
    });
    expect(add.statusCode).toBe(200);
    const meta = JSON.parse(add.body) as { imageId: number; caption: string; mime: string; sortOrder: number };
    expect(meta.caption).toBe('台所');
    expect(meta.mime).toBe('image/png');
    expect(meta.sortOrder).toBe(0);

    // 一覧。
    const list = await app.inject({ method: 'GET', url: `/api/goals/${goalId}/journal/${today}/images` });
    expect(list.statusCode).toBe(200);
    const metas = JSON.parse(list.body) as { imageId: number }[];
    expect(metas.map((m) => m.imageId)).toEqual([meta.imageId]);

    // バイナリ取得（Content-Type=mime・本体はバイト）。
    const bin = await app.inject({ method: 'GET', url: `/api/goals/${goalId}/journal/images/${meta.imageId}` });
    expect(bin.statusCode).toBe(200);
    expect(bin.headers['content-type']).toContain('image/png');
    expect(Buffer.from(bin.rawPayload).equals(Buffer.from([1, 2, 3]))).toBe(true);

    // キャプション更新。
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/goals/${goalId}/journal/images/${meta.imageId}`,
      payload: { caption: 'キッチン' },
    });
    expect(patch.statusCode).toBe(200);
    expect((JSON.parse(patch.body) as { caption: string }).caption).toBe('キッチン');

    // 削除。
    const del = await app.inject({ method: 'DELETE', url: `/api/goals/${goalId}/journal/images/${meta.imageId}` });
    expect(del.statusCode).toBe(200);
    expect((JSON.parse(del.body) as { deleted: boolean }).deleted).toBe(true);
    const after = await app.inject({ method: 'GET', url: `/api/goals/${goalId}/journal/${today}/images` });
    expect(JSON.parse(after.body)).toEqual([]);
  });

  it('完走後でも最終日への追加は 200（D4b: いつでも可）', async () => {
    const today = todayKey(db, Date.now());
    const start = addDaysKey(today, -40);
    const end = addDaysKey(today, -11); // 期間が過去＝完走。
    const goalId = insertGoal(start, end);
    const res = await app.inject({
      method: 'POST',
      url: `/api/goals/${goalId}/journal/${end}/images`, // 最終日(end_day)へ。
      payload: { dataUrl: PNG_DATA_URL, caption: '体・正面' },
    });
    expect(res.statusCode).toBe(200);
    expect((JSON.parse(res.body) as { caption: string }).caption).toBe('体・正面');
  });

  it('期間外の day_key は 400 で拒否される', async () => {
    const today = todayKey(db, Date.now());
    const start = addDaysKey(today, -5);
    const goalId = insertGoal(start, addDaysKey(start, 29));
    const res = await app.inject({
      method: 'POST',
      url: `/api/goals/${goalId}/journal/${addDaysKey(start, -1)}/images`, // 開始日の前日＝期間外。
      payload: { dataUrl: PNG_DATA_URL },
    });
    expect(res.statusCode).toBe(400);
  });

  it('非画像 mime は 400 で拒否される', async () => {
    const today = todayKey(db, Date.now());
    const goalId = insertGoal(today, addDaysKey(today, 29));
    const res = await app.inject({
      method: 'POST',
      url: `/api/goals/${goalId}/journal/${today}/images`,
      payload: { dataUrl: `data:text/plain;base64,${Buffer.from('x').toString('base64')}` },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('Plan / Check API（spec: goal-plan-check / goal-check-gate / goal-chronicle）', () => {
  const PLAN_BODY = 'ボリュームアップシャンプーを使えば髪質が良くなるのではないだろうか';

  /** 進行中（今日が Day1）の目標を作る。 */
  function activeGoal(): number {
    const today = todayKey(db, Date.now());
    return insertGoal(today, addDaysKey(today, 29));
  }

  /** Plan を1件作って id を返す。 */
  async function makePlan(goalId: number): Promise<number> {
    const res = await app.inject({
      method: 'POST',
      url: `/api/goals/${goalId}/plans`,
      payload: { body: PLAN_BODY },
    });
    expect(res.statusCode).toBe(200);
    return res.json().id;
  }

  /** Plan へ Check を1つ足して id を返す。 */
  async function makeCheck(planId: number, payload: Record<string, unknown>): Promise<number> {
    const res = await app.inject({ method: 'POST', url: `/api/goals/plans/${planId}/checks`, payload });
    expect(res.statusCode).toBe(200);
    return res.json().id;
  }

  const photoToday = { kind: 'photo', caption: '前髪・正面', schedule: 'single', startInDays: 0 };

  it('8.1 Plan の作成・一覧', async () => {
    const goalId = activeGoal();
    const planId = await makePlan(goalId);

    const list = await app.inject({ method: 'GET', url: `/api/goals/${goalId}/plans` });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toHaveLength(1);
    expect(list.json()[0]).toMatchObject({ id: planId, body: PLAN_BODY, status: 'active', checks: [] });
  });

  it('8.1 本文が空の Plan は 400 / 存在しない目標は 404', async () => {
    const goalId = activeGoal();
    const bad = await app.inject({ method: 'POST', url: `/api/goals/${goalId}/plans`, payload: { body: '  ' } });
    expect(bad.statusCode).toBe(400);

    const missing = await app.inject({ method: 'POST', url: '/api/goals/9999/plans', payload: { body: PLAN_BODY } });
    expect(missing.statusCode).toBe(404);
  });

  it('8.1 Check の作成（📷×単発・💬×範囲 の2軸が独立に組める）', async () => {
    const planId = await makePlan(activeGoal());

    const photo = await app.inject({
      method: 'POST',
      url: `/api/goals/plans/${planId}/checks`,
      payload: { kind: 'photo', caption: '前髪・正面', schedule: 'single', startInDays: 3, placeNote: '洗面所' },
    });
    expect(photo.statusCode).toBe(200);
    expect(photo.json()).toMatchObject({
      kind: 'photo',
      schedule: 'single',
      caption: '前髪・正面',
      placeNote: '洗面所',
    });

    const question = await app.inject({
      method: 'POST',
      url: `/api/goals/plans/${planId}/checks`,
      payload: { kind: 'question', questionText: '使用感はどうだった？', schedule: 'range', startInDays: 3, spanDays: 7 },
    });
    expect(question.statusCode).toBe(200);
    expect(question.json()).toMatchObject({ kind: 'question', schedule: 'range', spanDays: 7 });
  });

  it('8.1 Check の入力検証は 400（キャプション空・範囲1日）', async () => {
    const planId = await makePlan(activeGoal());
    const noCaption = await app.inject({
      method: 'POST',
      url: `/api/goals/plans/${planId}/checks`,
      payload: { kind: 'photo', caption: '', schedule: 'single', startInDays: 3 },
    });
    expect(noCaption.statusCode).toBe(400);

    const shortRange = await app.inject({
      method: 'POST',
      url: `/api/goals/plans/${planId}/checks`,
      payload: { kind: 'photo', caption: '前髪', schedule: 'range', startInDays: 3, spanDays: 1 },
    });
    expect(shortRange.statusCode).toBe(400);
    expect(shortRange.json().error).toMatch(/2日以上/);
  });

  it('8.2 写真提出はキャプションを送らず、先指定キャプションで画像が保存される', async () => {
    const goalId = activeGoal();
    const today = todayKey(db, Date.now());
    const checkId = await makeCheck(await makePlan(goalId), photoToday);

    const submit = await app.inject({
      method: 'POST',
      url: `/api/goal-checks/${checkId}/photo`,
      payload: { dataUrl: PNG_DATA_URL }, // caption は送らない。
    });
    expect(submit.statusCode).toBe(200);
    expect(submit.json().imageId).toBeTypeOf('number');

    // 画像は先指定キャプションで当日に保存され、③ Before/After へ流入する。
    const images = await app.inject({ method: 'GET', url: `/api/goals/${goalId}/journal/${today}/images` });
    expect(images.json()).toHaveLength(1);
    expect(images.json()[0]).toMatchObject({ caption: '前髪・正面' });
  });

  it('8.2 質問回答は保存され、空回答は 400', async () => {
    const checkId = await makeCheck(await makePlan(activeGoal()), {
      kind: 'question',
      questionText: '使用感は？',
      schedule: 'single',
      startInDays: 0,
    });

    const empty = await app.inject({
      method: 'POST',
      url: `/api/goal-checks/${checkId}/answer`,
      payload: { answerText: '  ' },
    });
    expect(empty.statusCode).toBe(400);

    const ok = await app.inject({
      method: 'POST',
      url: `/api/goal-checks/${checkId}/answer`,
      payload: { answerText: '泡立ちは良い。乾燥は減った気がする' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ answerText: '泡立ちは良い。乾燥は減った気がする' });
  });

  it('8.3 沿革を取得できる（取り下げも理由つきで残る）', async () => {
    const goalId = activeGoal();
    const planId = await makePlan(goalId);
    await makeCheck(planId, { kind: 'photo', caption: '前髪・正面', schedule: 'single', startInDays: 1 });

    const withdraw = await app.inject({
      method: 'POST',
      url: `/api/goals/plans/${planId}/withdraw`,
      payload: { reason: 'シャンプーが肌に合わず返品した' },
    });
    expect(withdraw.statusCode).toBe(200);

    const chronicle = await app.inject({ method: 'GET', url: `/api/goals/${goalId}/chronicle` });
    expect(chronicle.statusCode).toBe(200);
    expect(chronicle.json()).toMatchObject({
      goalId,
      plans: [
        {
          body: PLAN_BODY,
          status: 'withdrawn',
          withdrawReason: 'シャンプーが肌に合わず返品した',
          checks: [{ status: 'cancelled', cancelReason: 'シャンプーが肌に合わず返品した' }],
        },
      ],
    });
  });

  it('8.3 理由なしの取り下げは 400', async () => {
    const planId = await makePlan(activeGoal());
    const res = await app.inject({
      method: 'POST',
      url: `/api/goals/plans/${planId}/withdraw`,
      payload: { reason: '' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('8.4 その日に回答すべき Check を返す（回答すると消える）', async () => {
    const today = todayKey(db, Date.now());
    const checkId = await makeCheck(await makePlan(activeGoal()), photoToday);

    const due = await app.inject({ method: 'GET', url: `/api/goal-checks/due/${today}` });
    expect(due.statusCode).toBe(200);
    expect(due.json().checks).toHaveLength(1);
    expect(due.json().checks[0]).toMatchObject({
      checkId,
      label: '前髪・正面',
      kind: 'photo',
      planBody: PLAN_BODY,
    });

    await app.inject({ method: 'POST', url: `/api/goal-checks/${checkId}/photo`, payload: { dataUrl: PNG_DATA_URL } });
    expect((await app.inject({ method: 'GET', url: `/api/goal-checks/due/${today}` })).json().checks).toEqual([]);
  });

  it('8.4 開始日前の Check は due に出ない（仕掛けた直後はゲートに影響しない）', async () => {
    const today = todayKey(db, Date.now());
    await makeCheck(await makePlan(activeGoal()), {
      kind: 'photo',
      caption: '前髪・正面',
      schedule: 'single',
      startInDays: 3,
    });
    expect((await app.inject({ method: 'GET', url: `/api/goal-checks/due/${today}` })).json().checks).toEqual([]);
  });

  it('今日タブから理由つきで取り下げるとゲートから外れる', async () => {
    const today = todayKey(db, Date.now());
    const checkId = await makeCheck(await makePlan(activeGoal()), photoToday);

    const cancel = await app.inject({
      method: 'POST',
      url: `/api/goal-checks/${checkId}/cancel`,
      payload: { reason: 'シャンプーが肌に合わず返品した' },
    });
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json()).toMatchObject({ status: 'cancelled' });
    expect((await app.inject({ method: 'GET', url: `/api/goal-checks/due/${today}` })).json().checks).toEqual([]);
  });

  it('達成済みの Check の取り下げは 400 / 写真Check のキャプション変更は 409', async () => {
    const checkId = await makeCheck(await makePlan(activeGoal()), photoToday);

    const caption = await app.inject({
      method: 'PATCH',
      url: `/api/goal-checks/${checkId}/caption`,
      payload: { caption: '別のキャプション' },
    });
    expect(caption.statusCode).toBe(409);

    await app.inject({ method: 'POST', url: `/api/goal-checks/${checkId}/photo`, payload: { dataUrl: PNG_DATA_URL } });
    const cancel = await app.inject({
      method: 'POST',
      url: `/api/goal-checks/${checkId}/cancel`,
      payload: { reason: 'やめる' },
    });
    expect(cancel.statusCode).toBe(400);
    expect(cancel.json().error).toMatch(/達成済み/);
  });

  it('存在しない Check への操作は 404', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/goal-checks/9999/answer', payload: { answerText: 'x' } });
    expect(res.statusCode).toBe(404);
  });

  it('レポートは進行中でも 200（走行中プレビュー）で、⑤沿革を含む', async () => {
    const goalId = activeGoal();
    await makePlan(goalId);
    const rep = await app.inject({ method: 'GET', url: `/api/goals/${goalId}/report` });
    expect(rep.statusCode).toBe(200);
    expect(rep.json().goal).toMatchObject({ status: 'active', dayNumber: 1, showFinalPhotoCta: false });
    expect(rep.json().chronicle.plans).toHaveLength(1);
  });

  it('開始前の目標のレポートは 409（notReady）', async () => {
    const today = todayKey(db, Date.now());
    const upcoming = insertGoal(addDaysKey(today, 1), addDaysKey(today, 30));
    const rep = await app.inject({ method: 'GET', url: `/api/goals/${upcoming}/report` });
    expect(rep.statusCode).toBe(409);
    expect(rep.json().notReady).toBe(true);
  });
});
