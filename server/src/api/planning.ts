import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ApiDeps } from './types.js';
import { getReflection, saveReflection, listReflections } from '../services/reflection.js';
import { listTasks, createTask, updateTask, deleteTask, reorderTasks } from '../services/tasks.js';
import { refreshPlanningStatus } from '../services/planning.js';
import { todayKey } from '../services/summary.js';

// 並べ替え可能な列のみ受け入れる（DONE は完了アーカイブ経路のため対象外）。
const reorderBody = z.object({
  order: z
    .array(
      z.object({
        status: z.enum(['HOLD', 'TODO', 'DOING']),
        ids: z.array(z.number().int().positive()).min(1),
      }),
    )
    .min(1),
});

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
      due_locked?: number;
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

  // 列内一括再インデックス（design D2）。影響列ごとの順序付き id 配列を 1 トランザクションで
  // 適用し、パイプライン再実行は 1 回だけに集約する。
  app.post('/api/tasks/reorder', async (req, reply) => {
    const parsed = reorderBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: '不正な reorder ボディ', detail: parsed.error.issues };
    }
    const { order } = parsed.data;
    // 未知の id / 重複 id を弾く（列間で同一カードが二重に現れないことも保証）。
    const ids = order.flatMap((g) => g.ids);
    if (new Set(ids).size !== ids.length) {
      reply.code(400);
      return { error: 'reorder に重複した id が含まれています' };
    }
    const known = new Set(listTasks(db).map((t) => t.id));
    const unknown = ids.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      reply.code(400);
      return { error: `未知のタスク id: ${unknown.join(', ')}` };
    }
    reorderTasks(db, order);
    // 並べ替えは planning シグナルに影響しないが、既存経路に倣い 1 回だけ再評価する。
    refreshPlanningStatus(db, todayKey(db));
    deps.runPipeline();
    return listTasks(db);
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
