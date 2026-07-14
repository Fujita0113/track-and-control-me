import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { openDb, type DB } from '../db/index.js';
import { registerApiRoutes } from './index.js';

/**
 * かんばんタスクのカテゴリ受け入れ／バリデーション（kanban-task-category, tasks 4.2）。
 * POST/PATCH でグループ由来・自由入力・「その他」・スキップ（未指定）・除去（NULL化）を検証し、
 * 不整合入力（group_id あり name 無し等）を 400 で弾く。
 */

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

async function post(payload: Record<string, unknown>) {
  return app.inject({ method: 'POST', url: '/api/tasks', payload });
}
async function patch(id: number, payload: Record<string, unknown>) {
  return app.inject({ method: 'PATCH', url: `/api/tasks/${id}`, payload });
}

describe('POST /api/tasks のカテゴリ受け入れ', () => {
  it('グループ由来（UUID＋name＋color）を保存する', async () => {
    const res = await post({
      title: '競プロ',
      category_group_id: 'grp-x',
      category_name: '競技プログラミング',
      category_color: 'blue',
    });
    expect(res.statusCode).toBe(200);
    const t = JSON.parse(res.body);
    expect(t.category_group_id).toBe('grp-x');
    expect(t.category_name).toBe('競技プログラミング');
    expect(t.category_color).toBe('blue');
  });

  it('自由入力（name のみ）は group_id/color を null に正規化する', async () => {
    const res = await post({ title: '読書', category_name: '読書', category_color: 'blue' });
    expect(res.statusCode).toBe(200);
    const t = JSON.parse(res.body);
    expect(t.category_group_id).toBeNull();
    expect(t.category_name).toBe('読書');
    // group_id が無ければ色は落とす（自由入力は色なし）。
    expect(t.category_color).toBeNull();
  });

  it('「その他」を保存する', async () => {
    const res = await post({ title: '雑', category_name: 'その他' });
    expect(res.statusCode).toBe(200);
    const t = JSON.parse(res.body);
    expect(t.category_group_id).toBeNull();
    expect(t.category_name).toBe('その他');
  });

  it('カテゴリ未指定（スキップ）はカテゴリ無しで作成する', async () => {
    const res = await post({ title: '未分類' });
    expect(res.statusCode).toBe(200);
    const t = JSON.parse(res.body);
    expect(t.category_group_id).toBeNull();
    expect(t.category_name).toBeNull();
    expect(t.category_color).toBeNull();
  });

  it('group_id はあるが name が無い入力は 400', async () => {
    const res = await post({ title: 'ダメ', category_group_id: 'grp-x' });
    expect(res.statusCode).toBe(400);
  });
});

describe('PATCH /api/tasks/:id のカテゴリ更新', () => {
  it('後付け・除去（NULL化）ができる', async () => {
    const created = JSON.parse((await post({ title: 'あとで' })).body);
    // 後付け（グループ由来）。
    const p1 = await patch(created.id, {
      category_group_id: 'grp-y',
      category_name: '英語',
      category_color: 'green',
    });
    expect(p1.statusCode).toBe(200);
    expect(JSON.parse(p1.body).category_name).toBe('英語');
    // 除去（全 null）。
    const p2 = await patch(created.id, {
      category_group_id: null,
      category_name: null,
      category_color: null,
    });
    expect(p2.statusCode).toBe(200);
    const t = JSON.parse(p2.body);
    expect(t.category_group_id).toBeNull();
    expect(t.category_name).toBeNull();
    expect(t.category_color).toBeNull();
  });

  it('カテゴリ列を含まない PATCH は既存カテゴリを保持する（他フィールドのみ更新）', async () => {
    const created = JSON.parse(
      (await post({ title: 'キープ', category_group_id: 'grp-z', category_name: '数学', category_color: 'red' }))
        .body,
    );
    const res = await patch(created.id, { priority: 'high' });
    expect(res.statusCode).toBe(200);
    const t = JSON.parse(res.body);
    expect(t.priority).toBe('high');
    // カテゴリは触れられず残る。
    expect(t.category_group_id).toBe('grp-z');
    expect(t.category_name).toBe('数学');
    expect(t.category_color).toBe('red');
  });
});
