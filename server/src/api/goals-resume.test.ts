import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { openDb, type DB } from '../db/index.js';
import { registerApiRoutes } from './index.js';
import { todayKey } from '../services/summary.js';
import { addDaysKey } from '../services/goals.js';

/**
 * 発効済みの終了の再開 API（spec: goal-lifecycle-fork ADDED・issue #103）。
 * API は実時刻（Date.now）で進行中・発効を判定するため、goal 行は「今日」基準で直接作る。
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

/**
 * 発効済みの終了状態を直接構築する。API の `/end` は常に翌日発効（design D5）なので、
 * 呼んだ直後に `/resume` を試すと発効前として拒否される（=`resumeGoal` は
 * `isEnded(goal, today)` が真のときのみ許可・design D4）。実時刻での検証には使えないため、
 * `insertGoal` と同じ直接 SQL 方式で「today から見て既に発効済みの終了」を組み立てる。
 */
function endedGoal(name = '設計理解をしたい'): { id: number; today: string } {
  const today = todayKey(db, Date.now());
  const id = insertGoal(name, addDaysKey(today, -10), addDaysKey(today, 18));
  db.prepare(
    `UPDATE goal SET ended_day_key = ?, end_reason = ?, lifecycle_choice = 'ended', lifecycle_reason = ?
      WHERE id = ?`,
  ).run(addDaysKey(today, -1), '一旦終える', '一旦終える', id);
  return { id, today };
}

describe('再開 API', () => {
  it('発効済みの終了は理由つきで再開でき、発効日は翌日になる', async () => {
    const { id, today } = endedGoal();
    const res = await app.inject({
      method: 'POST',
      url: `/api/goals/${id}/resume`,
      payload: { reason: 'コーディングテストが終わったので再開したい' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { status: string; resumingOn: string | null };
    expect(body.status).toBe('ended');
    expect(body.resumingOn).toBe(addDaysKey(today, 1));
  });

  it('理由が空の再開は 400', async () => {
    const { id } = endedGoal();
    const res = await app.inject({ method: 'POST', url: `/api/goals/${id}/resume`, payload: { reason: '  ' } });
    expect(res.statusCode).toBe(400);
  });

  it('進行中の（終了していない）目標の再開は 409', async () => {
    const today = todayKey(db, Date.now());
    const id = insertGoal('進行中', today, addDaysKey(today, 29));
    const res = await app.inject({
      method: 'POST',
      url: `/api/goals/${id}/resume`,
      payload: { reason: '再開したい' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('発効前なら再開の取消は 200', async () => {
    const { id } = endedGoal();
    await app.inject({ method: 'POST', url: `/api/goals/${id}/resume`, payload: { reason: '再開したい' } });
    const res = await app.inject({ method: 'POST', url: `/api/goals/${id}/resume/cancel` });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { status: string; resumingOn: string | null };
    expect(body.status).toBe('ended');
    expect(body.resumingOn).toBeNull();
  });

  it('再開予約が無い状態での取消は 409', async () => {
    const { id } = endedGoal();
    const res = await app.inject({ method: 'POST', url: `/api/goals/${id}/resume/cancel` });
    expect(res.statusCode).toBe(409);
  });
});
