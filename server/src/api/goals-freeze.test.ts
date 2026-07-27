import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { openDb, type DB } from '../db/index.js';
import { registerApiRoutes } from './index.js';
import { todayKey } from '../services/summary.js';
import { addDaysKey } from '../services/goals.js';

/**
 * 一時凍結の API（spec: goal-freeze・issue #60）。
 * API は実時刻（Date.now）で進行中・発効を判定するため、goal 行は「今日」基準で直接作る。
 * 予約は必ず「翌日発効」なので、同じ日に打った2件は必ず同じ月に落ちる（月枠の検証が日付に依らない）。
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

function insertGoal(name: string, startDay: string, endDay: string): number {
  return db
    .prepare('INSERT INTO goal (name, purpose, start_day, end_day, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(name, '', startDay, endDay, Date.now()).lastInsertRowid as number;
}

/** 今日開始・30日の進行中目標。 */
function activeGoal(name = '設計理解をしたい'): { id: number; today: string } {
  const today = todayKey(db, Date.now());
  return { id: insertGoal(name, today, addDaysKey(today, 29)), today };
}

describe('凍結 API', () => {
  it('予約は 200 で、発効日は翌日になる', async () => {
    const { id, today } = activeGoal();
    const res = await app.inject({
      method: 'POST',
      url: `/api/goals/${id}/freeze`,
      payload: { endDay: addDaysKey(today, 5), reason: 'OpenWork の大タスク' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { startDay: string; endDay: string; state: string };
    expect(body.startDay).toBe(addDaysKey(today, 1));
    expect(body.endDay).toBe(addDaysKey(today, 5));
    expect(body.state).toBe('reserved');
  });

  it('理由が空の予約は 400', async () => {
    const { id, today } = activeGoal();
    const res = await app.inject({
      method: 'POST',
      url: `/api/goals/${id}/freeze`,
      payload: { endDay: addDaysKey(today, 5), reason: '  ' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('同じ月の2件目は 409', async () => {
    const { id, today } = activeGoal('設計理解をしたい');
    const b = activeGoal('茶色取りたい');
    const first = await app.inject({
      method: 'POST',
      url: `/api/goals/${id}/freeze`,
      payload: { endDay: addDaysKey(today, 5), reason: '大タスク' },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: 'POST',
      url: `/api/goals/${b.id}/freeze`,
      payload: { endDay: addDaysKey(today, 5), reason: '別件' },
    });
    expect(second.statusCode).toBe(409);
  });

  it('発効前の解除は 409（取消を使う）', async () => {
    const { id, today } = activeGoal();
    await app.inject({
      method: 'POST',
      url: `/api/goals/${id}/freeze`,
      payload: { endDay: addDaysKey(today, 5), reason: '大タスク' },
    });
    const res = await app.inject({ method: 'POST', url: `/api/goals/${id}/freeze/release` });
    expect(res.statusCode).toBe(409);
  });

  it('発効前の取消は 200 で、枠が戻る', async () => {
    const { id, today } = activeGoal();
    await app.inject({
      method: 'POST',
      url: `/api/goals/${id}/freeze`,
      payload: { endDay: addDaysKey(today, 5), reason: '大タスク' },
    });
    const del = await app.inject({ method: 'DELETE', url: `/api/goals/${id}/freeze` });
    expect(del.statusCode).toBe(200);

    const quota = await app.inject({ method: 'GET', url: '/api/goals/freeze/quota' });
    expect(quota.statusCode).toBe(200);
    expect((JSON.parse(quota.body) as { used: boolean }).used).toBe(false);
  });

  it('枠の状態は使った目標が分かる形で返る', async () => {
    const { id, today } = activeGoal('設計理解をしたい');
    await app.inject({
      method: 'POST',
      url: `/api/goals/${id}/freeze`,
      payload: { endDay: addDaysKey(today, 5), reason: '大タスク' },
    });
    const res = await app.inject({ method: 'GET', url: '/api/goals/freeze/quota' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { used: boolean; goalId: number | null; goalName: string | null };
    expect(body.used).toBe(true);
    expect(body.goalId).toBe(id);
    expect(body.goalName).toBe('設計理解をしたい');
  });
});
