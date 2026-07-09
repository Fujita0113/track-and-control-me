import type { FastifyInstance } from 'fastify';
import type { ApiDeps } from './types.js';
import { getReflection, saveReflection, listReflections } from '../services/reflection.js';
import { listTasks, createTask, updateTask, deleteTask } from '../services/tasks.js';
import { refreshPlanningStatus } from '../services/planning.js';
import { todayKey } from '../services/summary.js';

/** 振り返り・カンバン・PLANNING シグナル API（tasks 9.1–9.4）。 */
export function registerPlanningRoutes(app: FastifyInstance, deps: ApiDeps): void {
  const { db } = deps;

  // --- 振り返り -----------------------------------------------------------
  // 保存済み振り返りの日付一覧（過去参照用）。:date より先に定義する。
  app.get('/api/reflections', async () => listReflections(db));

  app.get('/api/reflection/:date', async (req) => {
    const { date } = req.params as { date: string };
    return (
      getReflection(db, date) ?? {
        date,
        content: '',
        satisfaction: null,
        created_at: null,
        updated_at: null,
      }
    );
  });

  app.put('/api/reflection/:date', async (req) => {
    const { date } = req.params as { date: string };
    const b = (req.body ?? {}) as { content?: string; satisfaction?: number | null };
    const saved = saveReflection(db, date, b.content ?? '', b.satisfaction ?? null);
    refreshPlanningStatus(db, date);
    deps.runPipeline(); // PLANNING 条件の再評価
    return saved;
  });

  // --- カンバン -----------------------------------------------------------
  app.get('/api/tasks', async () => listTasks(db));

  app.post('/api/tasks', async (req, reply) => {
    const b = req.body as {
      title: string;
      description?: string | null;
      status?: string;
      planned_for?: string | null;
      priority?: string;
      due?: string | null;
      notes?: string | null;
    };
    if (!b?.title) {
      reply.code(400);
      return { error: 'title は必須' };
    }
    const task = createTask(db, b);
    // 予定日/期限のどちらでも PLANNING（翌日タスク数）に影響しうるため再評価。
    if (b.planned_for || b.due) refreshPlanningStatus(db, todayKey(db));
    deps.runPipeline();
    return task;
  });

  app.patch('/api/tasks/:id', async (req) => {
    const { id } = req.params as { id: string };
    const patch = req.body as Record<string, unknown>;
    const task = updateTask(db, Number(id), patch);
    refreshPlanningStatus(db, todayKey(db));
    deps.runPipeline();
    return task ?? { error: 'not found' };
  });

  app.delete('/api/tasks/:id', async (req) => {
    const { id } = req.params as { id: string };
    const deleted = deleteTask(db, Number(id));
    refreshPlanningStatus(db, todayKey(db));
    deps.runPipeline();
    return { deleted };
  });

  // --- PLANNING シグナル --------------------------------------------------
  app.get('/api/planning/:date', async (req) => {
    const { date } = req.params as { date: string };
    return refreshPlanningStatus(db, date);
  });
}
