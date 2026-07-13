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
