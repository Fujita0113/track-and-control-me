import type { FastifyInstance } from 'fastify';
import type { ApiDeps } from './types.js';
import {
  adoptCandidates,
  createGoal,
  listGoals,
  getGoal,
  deleteGoal,
  getGoalReport,
  getJournal,
  saveJournal,
  GoalNotFoundError,
  GoalPracticeError,
  GoalDeleteWindowError,
  GoalReportNotReadyError,
  JournalNotWritableError,
} from '../services/goals.js';

/** 30日チャレンジ API（spec: goal-challenge / goal-journal / goal-report）。 */
export function registerGoalRoutes(app: FastifyInstance, deps: ApiDeps): void {
  const { db } = deps;

  // 採用候補（翌日実効ルール）。:id より先に定義する（静的セグメント優先の明示）。
  app.get('/api/goals/candidates', async () => adoptCandidates(db));

  app.get('/api/goals', async () => listGoals(db));

  app.post('/api/goals', async (req, reply) => {
    const b = (req.body ?? {}) as { name?: string; purpose?: string; practices?: string[] };
    try {
      return createGoal(db, { name: b.name ?? '', purpose: b.purpose, practices: b.practices ?? [] });
    } catch (err) {
      if (err instanceof GoalPracticeError) {
        reply.code(400);
        return { error: err.message };
      }
      throw err;
    }
  });

  app.get('/api/goals/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    try {
      return getGoal(db, id);
    } catch (err) {
      if (err instanceof GoalNotFoundError) {
        reply.code(404);
        return { error: err.message };
      }
      throw err;
    }
  });

  app.delete('/api/goals/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    try {
      return { deleted: deleteGoal(db, id) };
    } catch (err) {
      if (err instanceof GoalNotFoundError) {
        reply.code(404);
        return { error: err.message };
      }
      if (err instanceof GoalDeleteWindowError) {
        reply.code(409);
        return { error: err.message };
      }
      throw err;
    }
  });

  app.get('/api/goals/:id/report', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    try {
      return getGoalReport(db, id);
    } catch (err) {
      if (err instanceof GoalNotFoundError) {
        reply.code(404);
        return { error: err.message };
      }
      if (err instanceof GoalReportNotReadyError) {
        reply.code(409);
        return { error: err.message, notReady: true };
      }
      throw err;
    }
  });

  app.get('/api/goals/:id/journal/:date', async (req, reply) => {
    const { id, date } = req.params as { id: string; date: string };
    try {
      getGoal(db, Number(id)); // 存在確認（無ければ 404）。
      return getJournal(db, Number(id), date);
    } catch (err) {
      if (err instanceof GoalNotFoundError) {
        reply.code(404);
        return { error: err.message };
      }
      throw err;
    }
  });

  app.put('/api/goals/:id/journal/:date', async (req, reply) => {
    const { id, date } = req.params as { id: string; date: string };
    const b = (req.body ?? {}) as { content?: string };
    try {
      return saveJournal(db, Number(id), date, b.content ?? '');
    } catch (err) {
      if (err instanceof GoalNotFoundError) {
        reply.code(404);
        return { error: err.message };
      }
      if (err instanceof JournalNotWritableError) {
        reply.code(409);
        return { error: err.message };
      }
      throw err;
    }
  });
}
