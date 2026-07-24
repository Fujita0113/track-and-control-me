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

describe('目標・ルール API（spec: editable-rule-registry / goal-lifecycle-fork）', () => {
  /** 進行中（今日が Day1）の目標を作る（1つ以上のルールを添えて作成）。 */
  async function createActiveGoal(rules: Record<string, unknown>[]): Promise<{ id: number; ruleId: number }> {
    const res = await app.inject({ method: 'POST', url: '/api/goals', payload: { name: '目標', rules } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    return { id: body.id, ruleId: body.rules[0].ruleId };
  }

  it('6.1 目標作成: ルール1件以上必須・理由必須（reason 空は400）', async () => {
    const noRules = await app.inject({ method: 'POST', url: '/api/goals', payload: { name: 'x', rules: [] } });
    expect(noRules.statusCode).toBe(400);

    const noReason = await app.inject({
      method: 'POST',
      url: '/api/goals',
      payload: { name: 'x', rules: [{ target: 'TOTAL_WORK', thresholdSeconds: 100, reason: '' }] },
    });
    expect(noReason.statusCode).toBe(400);
  });

  it('6.1 目標コーナーでルールを追加・変更・削除できる（理由必須）', async () => {
    const { id: goalId } = await createActiveGoal([{ target: 'TOTAL_WORK', thresholdSeconds: 14400, reason: '4時間は守りたい' }]);

    const add = await app.inject({
      method: 'POST',
      url: `/api/goals/${goalId}/rules`,
      payload: { target: 'MANUAL_CHECK', label: '筋トレ', reason: '体を動かしたい' },
    });
    expect(add.statusCode).toBe(200);
    const ruleId = add.json().rule.ruleId ?? add.json().rule.id;

    const noReason = await app.inject({
      method: 'PATCH',
      url: `/api/goals/${goalId}/rules/${ruleId}`,
      payload: { target: 'MANUAL_CHECK', label: '筋トレ', reason: '' },
    });
    expect(noReason.statusCode).toBe(400);

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/goals/${goalId}/rules/${ruleId}`,
      payload: { reason: '反応が薄いから' },
    });
    expect(del.statusCode).toBe(200);

    const noReasonDelete = await app.inject({ method: 'DELETE', url: `/api/goals/${goalId}/rules/${ruleId}`, payload: {} });
    expect(noReasonDelete.statusCode).toBe(400);
  });

  it('6.2 延長フォーク: 未指定は409（proposedEndDay 付き）・extend/truncate 両分岐', async () => {
    const { id: goalId } = await createActiveGoal([{ target: 'TOTAL_WORK', thresholdSeconds: 100, reason: 'r' }]);
    const today = todayKey(db, Date.now());
    const overEnd = addDaysKey(today, 33);

    const undecided = await app.inject({
      method: 'POST',
      url: `/api/goals/${goalId}/rules`,
      payload: { target: 'PHOTO', caption: '前髪', startDay: addDaysKey(today, 29), endDay: overEnd, reason: 'r' },
    });
    expect(undecided.statusCode).toBe(409);
    expect(undecided.json().extensionRequired).toBe(true);
    expect(undecided.json().proposedEndDay).toBe(overEnd);

    const extend = await app.inject({
      method: 'POST',
      url: `/api/goals/${goalId}/rules`,
      payload: { target: 'PHOTO', caption: '前髪', startDay: addDaysKey(today, 29), endDay: overEnd, reason: 'r', extend: 'extend' },
    });
    expect(extend.statusCode).toBe(200);
    expect(extend.json().truncated).toBe(false);
    const afterExtend = await app.inject({ method: 'GET', url: `/api/goals/${goalId}` });
    expect(afterExtend.json().endDay).toBe(overEnd);

    // 2件目: 'truncate' 分岐（目標末尾まで切り詰めて作成は成功する）。
    const goalEnd = afterExtend.json().endDay as string;
    const anotherOverEnd = addDaysKey(goalEnd, 5);
    const truncate = await app.inject({
      method: 'POST',
      url: `/api/goals/${goalId}/rules`,
      payload: { target: 'QUESTION', questionText: 'どう？', startDay: goalEnd, endDay: anotherOverEnd, reason: 'r', extend: 'truncate' },
    });
    expect(truncate.statusCode).toBe(200);
    expect(truncate.json().truncated).toBe(true);
    expect(truncate.json().rule.end_day).toBe(goalEnd);
    const afterTruncate = await app.inject({ method: 'GET', url: `/api/goals/${goalId}` });
    expect(afterTruncate.json().endDay).toBe(goalEnd); // 目標は延びない。
  });

  it('6.2 完走フォーク: 続ける/終える 両分岐', async () => {
    const today = todayKey(db, Date.now());
    const start = addDaysKey(today, -40);
    const end = addDaysKey(today, -11);
    const goalId = insertGoal(start, end); // 直接 DB へ完走済み目標を作る。
    db.prepare(
      "INSERT INTO rule (target, comparator, threshold_seconds, start_day, end_day, status, created_at) VALUES ('TOTAL_WORK', 'GTE', 100, ?, NULL, 'active', ?)",
    ).run(start, Date.now());
    const ruleId = (db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id;
    db.prepare('INSERT INTO goal_rule (goal_id, rule_id) VALUES (?, ?)').run(goalId, ruleId);

    const notCompleted = await app.inject({ method: 'POST', url: `/api/goals/${insertGoal(today, addDaysKey(today, 29))}/continue` });
    expect(notCompleted.statusCode).toBe(409);

    const cont = await app.inject({ method: 'POST', url: `/api/goals/${goalId}/continue` });
    expect(cont.statusCode).toBe(200);
    expect(cont.json().status).toBe('active');
    expect(cont.json().dayNumber).toBe(1);

    // 別の完走目標で「終える」分岐。
    const goalId2 = insertGoal(start, end);
    db.prepare(
      "INSERT INTO rule (target, comparator, threshold_seconds, start_day, end_day, status, created_at) VALUES ('TOTAL_WORK', 'GTE', 100, ?, NULL, 'active', ?)",
    ).run(start, Date.now());
    const ruleId2 = (db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id;
    db.prepare('INSERT INTO goal_rule (goal_id, rule_id) VALUES (?, ?)').run(goalId2, ruleId2);

    const end_ = await app.inject({ method: 'POST', url: `/api/goals/${goalId2}/end`, payload: { reason: 'もう十分' } });
    expect(end_.statusCode).toBe(200);
    expect(end_.json().lifecycleChoice).toBe('ended');
    const ruleRow = db.prepare('SELECT status FROM rule WHERE id = ?').get(ruleId2) as { status: string };
    expect(ruleRow.status).toBe('removed');
  });

  it('6.3/6.4 今日タブの書き込みエンドポイントは存在しない（旧 /api/rules・/api/checks 系）', async () => {
    const putRules = await app.inject({ method: 'PUT', url: '/api/rules/2026-07-10', payload: { conditions: [] } });
    expect(putRules.statusCode).toBe(404);
    const deleteRules = await app.inject({ method: 'DELETE', url: '/api/rules/2026-07-10' });
    expect(deleteRules.statusCode).toBe(404);
    const plans = await app.inject({ method: 'POST', url: '/api/goals/1/plans', payload: {} });
    expect(plans.statusCode).toBe(404);
  });

  it('6.3 写真/質問ルールへの回答は /api/rules/:ruleId/photo・answer', async () => {
    const today = todayKey(db, Date.now());
    const { id: goalId, ruleId } = await createActiveGoal([
      { target: 'PHOTO', caption: '前髪・正面', startDay: today, endDay: today, reason: 'r' },
    ]);

    const due = await app.inject({ method: 'GET', url: `/api/due-rules/${today}` });
    expect(due.statusCode).toBe(200);
    expect(due.json().rules).toHaveLength(1);
    expect(due.json().rules[0]).toMatchObject({ ruleId, goalId, label: '前髪・正面' });

    const submit = await app.inject({ method: 'POST', url: `/api/rules/${ruleId}/photo`, payload: { dataUrl: PNG_DATA_URL } });
    expect(submit.statusCode).toBe(200);
    expect(submit.json().imageId).toBeTypeOf('number');
    expect((await app.inject({ method: 'GET', url: `/api/due-rules/${today}` })).json().rules).toEqual([]);
  });

  it('質問への空回答は400、存在しないルールへの操作は404', async () => {
    const today = todayKey(db, Date.now());
    const { ruleId } = await createActiveGoal([
      { target: 'QUESTION', questionText: '使用感は？', startDay: today, endDay: today, reason: 'r' },
    ]);
    const empty = await app.inject({ method: 'POST', url: `/api/rules/${ruleId}/answer`, payload: { answerText: '  ' } });
    expect(empty.statusCode).toBe(400);
    const ok = await app.inject({ method: 'POST', url: `/api/rules/${ruleId}/answer`, payload: { answerText: '泡立ちは良い' } });
    expect(ok.statusCode).toBe(200);
    const missing = await app.inject({ method: 'POST', url: '/api/rules/9999/answer', payload: { answerText: 'x' } });
    expect(missing.statusCode).toBe(404);
  });

  it('⑤沿革を取得できる', async () => {
    const { id: goalId } = await createActiveGoal([{ target: 'TOTAL_WORK', thresholdSeconds: 100, reason: '守りたい' }]);
    const chronicle = await app.inject({ method: 'GET', url: `/api/goals/${goalId}/chronicle` });
    expect(chronicle.statusCode).toBe(200);
    expect(chronicle.json().entries[0]).toMatchObject({ target: 'TOTAL_WORK', change: { op: 'add', reason: '守りたい' } });
  });

  it('レポートは進行中でも 200（走行中プレビュー）', async () => {
    const { id: goalId } = await createActiveGoal([{ target: 'TOTAL_WORK', thresholdSeconds: 100, reason: 'r' }]);
    const rep = await app.inject({ method: 'GET', url: `/api/goals/${goalId}/report` });
    expect(rep.statusCode).toBe(200);
    expect(rep.json().goal).toMatchObject({ status: 'active', dayNumber: 1, showFinalPhotoCta: false });
  });

  it('開始前の目標のレポートは 409（notReady）', async () => {
    const today = todayKey(db, Date.now());
    const upcoming = insertGoal(addDaysKey(today, 1), addDaysKey(today, 30));
    const rep = await app.inject({ method: 'GET', url: `/api/goals/${upcoming}/report` });
    expect(rep.statusCode).toBe(409);
    expect(rep.json().notReady).toBe(true);
  });
});
