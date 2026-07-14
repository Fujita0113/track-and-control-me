import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ApiDeps } from './types.js';
import { getReflection, saveReflection, listReflections } from '../services/reflection.js';
import { listTasks, createTask, updateTask, deleteTask, reorderTasks } from '../services/tasks.js';
import { refreshPlanningStatus } from '../services/planning.js';
import { todayKey } from '../services/summary.js';

/**
 * カテゴリ入力の正規化・バリデーション（kanban-task-category, design D1〜D3）。
 * 3列すべて未指定なら「カテゴリに触れない」（undefined を返す）。
 * 3列すべて null（明示）なら「カテゴリ除去」。
 * category_group_id があれば name/color を伴うタブグループ由来、無ければ自由入力（name のみ・色なし）。
 * color は照合に使わない表示専用スナップショットのため enum で縛らない（DB も緩いまま・D2）。
 * @returns { ok, value } value=undefined は触れない / value={3列} は書き込む。error は 400 用メッセージ。
 */
type CategoryPatch = {
  category_group_id: string | null;
  category_name: string | null;
  category_color: string | null;
};
function normalizeCategory(
  b: Record<string, unknown>,
): { ok: true; value?: CategoryPatch } | { ok: false; error: string } {
  const has = (k: string) => Object.prototype.hasOwnProperty.call(b, k);
  if (!has('category_group_id') && !has('category_name') && !has('category_color')) {
    return { ok: true }; // 触れない（従来挙動）。
  }
  const rawId = b.category_group_id;
  const rawName = b.category_name;
  const rawColor = b.category_color;
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const gid = str(rawId);
  const name = str(rawName);
  const color = str(rawColor);

  // すべて空（明示 null / 空文字）＝カテゴリ除去。
  if (!gid && !name && !color) {
    return { ok: true, value: { category_group_id: null, category_name: null, category_color: null } };
  }
  // 型チェック（文字列 or null/undefined のみ許容）。
  for (const [k, v] of [
    ['category_group_id', rawId],
    ['category_name', rawName],
    ['category_color', rawColor],
  ] as const) {
    if (v != null && typeof v !== 'string') return { ok: false, error: `${k} は文字列` };
  }
  // グループ由来（UUID あり）は表示名を必須にする（バッジ表示が壊れないため）。
  if (gid && !name) return { ok: false, error: 'category_group_id には category_name が必要' };
  // 名前が無ければカテゴリとして成立しない（色だけの付与は不可）。
  if (!name) return { ok: false, error: 'category_name が必要' };
  return {
    ok: true,
    value: {
      category_group_id: gid || null,
      category_name: name,
      // 自由入力（グループ非紐付け）は色なしに正規化。グループ由来は色スナップショットを保持。
      category_color: gid ? color || null : null,
    },
  };
}

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
    const cat = normalizeCategory((req.body ?? {}) as Record<string, unknown>);
    if (!cat.ok) {
      reply.code(400);
      return { error: cat.error };
    }
    const task = createTask(db, { ...b, ...(cat.value ?? {}) });
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

  app.patch('/api/tasks/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const patch = { ...(req.body as Record<string, unknown>) };
    // カテゴリ3列は正規化して差し替える（グループ由来⟹name必須・自由入力⟹色なし・除去はNULL化）。
    const cat = normalizeCategory(patch);
    if (!cat.ok) {
      reply.code(400);
      return { error: cat.error };
    }
    delete patch.category_group_id;
    delete patch.category_name;
    delete patch.category_color;
    if (cat.value) Object.assign(patch, cat.value);
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
