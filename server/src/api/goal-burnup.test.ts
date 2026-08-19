import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { openDb, type DB } from '../db/index.js';
import { registerApiRoutes } from './index.js';
import { todayKey } from '../services/summary.js';
import { addDaysKey } from '../services/goals.js';

/**
 * 見通しと想定時間の API（spec: goal-burnup / task-estimate）。
 *
 * - `GET /api/goals/:id/burnup` は**算定済みの値**を返す（クライアントは割り算をしない）。
 * - `PUT /api/tasks/:id/estimate` `/progress` は外部エージェント（Gemini / Antigravity）が叩く口。
 *   理由と実行者を必須にし、範囲だけを検証して**値の妥当性は問わない**。
 *
 * API は実時刻で進行中判定するため、goal 行を「今日」基準で直接作る。
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

function insertGoal(startDay: string, endDay: string): number {
  return db
    .prepare('INSERT INTO goal (name, purpose, start_day, end_day, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('設計理解', 'できている', startDay, endDay, Date.now()).lastInsertRowid as number;
}

async function addRoot(goalId: number, title: string): Promise<number> {
  const res = await app.inject({ method: 'POST', url: `/api/goals/${goalId}/blueprint/root`, payload: { title } });
  expect(res.statusCode).toBe(200);
  return res.json().id as number;
}

describe('GET /api/goals/:id/burnup', () => {
  it('進行中の目標で 200 と算定済みの値を返す', async () => {
    const today = todayKey(db, Date.now());
    const goalId = insertGoal(today, addDaysKey(today, 149));

    const res = await app.inject({ method: 'GET', url: `/api/goals/${goalId}/burnup` });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body).toHaveProperty('points');
    expect(body).toHaveProperty('remainingSeconds');
    expect(body.overall).toHaveProperty('averageSecondsPerDay');
    expect(body.overall).toHaveProperty('projectedDay');
    expect(body.recent3).toHaveProperty('projectedDay');
    expect(body).toHaveProperty('scopeChanges');
  });

  it('開始前の目標は 409 で断る（404 ではない）', async () => {
    const today = todayKey(db, Date.now());
    const start = addDaysKey(today, 1);
    const goalId = insertGoal(start, addDaysKey(start, 149));

    // 「断った」と「ルートが無い」を区別する。404 で通してはならない。
    const res = await app.inject({ method: 'GET', url: `/api/goals/${goalId}/burnup` });
    expect(res.statusCode).toBe(409);
  });

  it('完走後も見通しは開けるが、完了予想日は返らない', async () => {
    const today = todayKey(db, Date.now());
    const goalId = insertGoal(addDaysKey(today, -200), addDaysKey(today, -1));

    const res = await app.inject({ method: 'GET', url: `/api/goals/${goalId}/burnup` });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.overall.projectedDay).toBeNull();
    expect(body.recent3.projectedDay).toBeNull();
    expect(body).toHaveProperty('points');
  });

  it('レポート API は廃止されている（進行中・完走後とも 404）', async () => {
    const today = todayKey(db, Date.now());
    const running = insertGoal(today, addDaysKey(today, 149));
    const done = insertGoal(addDaysKey(today, -200), addDaysKey(today, -1));

    for (const id of [running, done]) {
      const res = await app.inject({ method: 'GET', url: `/api/goals/${id}/report` });
      expect(res.statusCode).toBe(404);
    }
  });
});

describe('PUT /api/tasks/:id/estimate', () => {
  it('理由と実行者を添えると保存され、記録が1行増え、見通しへ反映される', async () => {
    const today = todayKey(db, Date.now());
    const goalId = insertGoal(today, addDaysKey(today, 149));
    const rootId = await addRoot(goalId, 'Udemy で講座一周見る');

    const res = await app.inject({
      method: 'PUT',
      url: `/api/tasks/${rootId}/estimate`,
      payload: { estimatedSeconds: 64 * 3600, reason: '一周目と同じくらいと仮定', actor: 'agent' },
    });
    expect(res.statusCode).toBe(200);

    const n = db.prepare('SELECT COUNT(*) AS c FROM task_estimate_change WHERE task_id = ?').get(rootId) as {
      c: number;
    };
    expect(n.c).toBe(1);

    const burnup = await app.inject({ method: 'GET', url: `/api/goals/${goalId}/burnup` });
    expect(burnup.json().remainingSeconds).toBe(64 * 3600);
  });

  it('理由が空なら 400 で、値も記録も変わらない', async () => {
    const today = todayKey(db, Date.now());
    const goalId = insertGoal(today, addDaysKey(today, 149));
    const rootId = await addRoot(goalId, 'Udemy で講座一周見る');

    const res = await app.inject({
      method: 'PUT',
      url: `/api/tasks/${rootId}/estimate`,
      payload: { estimatedSeconds: 64 * 3600, actor: 'agent' },
    });
    expect(res.statusCode).toBe(400);

    const n = db.prepare('SELECT COUNT(*) AS c FROM task_estimate_change WHERE task_id = ?').get(rootId) as {
      c: number;
    };
    expect(n.c).toBe(0);
  });

  it('負の想定時間は 400', async () => {
    const today = todayKey(db, Date.now());
    const goalId = insertGoal(today, addDaysKey(today, 149));
    const rootId = await addRoot(goalId, 'Udemy で講座一周見る');

    const res = await app.inject({
      method: 'PUT',
      url: `/api/tasks/${rootId}/estimate`,
      payload: { estimatedSeconds: -1, reason: '誤入力', actor: 'agent' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('実測から見て不自然に小さい値でも受理する（警告も補正もしない）', async () => {
    const today = todayKey(db, Date.now());
    const goalId = insertGoal(today, addDaysKey(today, 149));
    const rootId = await addRoot(goalId, 'Udemy で講座一周見る');

    const res = await app.inject({
      method: 'PUT',
      url: `/api/tasks/${rootId}/estimate`,
      payload: { estimatedSeconds: 3600, reason: 'たぶん1時間で終わる', actor: 'agent' },
    });
    expect(res.statusCode).toBe(200);

    const burnup = await app.inject({ method: 'GET', url: `/api/goals/${goalId}/burnup` });
    expect(burnup.json().remainingSeconds).toBe(3600);
  });
});

describe('PUT /api/tasks/:id/progress', () => {
  it('葉に 0.8 を置ける', async () => {
    const today = todayKey(db, Date.now());
    const goalId = insertGoal(today, addDaysKey(today, 149));
    const rootId = await addRoot(goalId, 'Udemy で講座一周見る');
    const child = await app.inject({
      method: 'POST',
      url: `/api/tasks/${rootId}/children`,
      payload: { title: 'sec10' },
    });
    expect(child.statusCode).toBe(200);
    const leafId = child.json().id as number;

    const res = await app.inject({
      method: 'PUT',
      url: `/api/tasks/${leafId}/progress`,
      payload: { ratio: 0.8, reason: '1個も終わってないが8割方は読めている', actor: 'agent' },
    });
    expect(res.statusCode).toBe(200);

    const row = db.prepare('SELECT progress_ratio FROM task WHERE id = ?').get(leafId) as {
      progress_ratio: number;
    };
    expect(row.progress_ratio).toBeCloseTo(0.8, 6);
  });

  it('1 を超える進捗は 400', async () => {
    const today = todayKey(db, Date.now());
    const goalId = insertGoal(today, addDaysKey(today, 149));
    const rootId = await addRoot(goalId, 'Udemy で講座一周見る');
    const child = await app.inject({
      method: 'POST',
      url: `/api/tasks/${rootId}/children`,
      payload: { title: 'sec10' },
    });
    const leafId = child.json().id as number;

    const res = await app.inject({
      method: 'PUT',
      url: `/api/tasks/${leafId}/progress`,
      payload: { ratio: 1.4, reason: 'r', actor: 'agent' },
    });
    expect(res.statusCode).toBe(400);
  });
});
