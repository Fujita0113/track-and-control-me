import type { DB } from '../db/index.js';

/** タスクカンバン（spec: reflection-and-planning / kanban-board）。 */

// UI 刷新後の列: HOLD(保留)/TODO(未着手)/DOING(進行中)/DONE(完了)。
// 旧値(BACKLOG/TODAY/TOMORROW)も string として保持互換。
export type TaskStatus = 'HOLD' | 'TODO' | 'DOING' | 'DONE' | string;
export type TaskPriority = 'high' | 'mid' | 'low' | string;

export interface TaskRow {
  id: number;
  title: string;
  description: string | null;
  status: TaskStatus;
  planned_for: string | null;
  priority: TaskPriority;
  due: string | null;
  notes: string | null;
  sort_order: number;
  created_at: number;
  done_at: number | null;
  updated_at: number;
}

export function listTasks(db: DB): TaskRow[] {
  return db.prepare('SELECT * FROM task ORDER BY status, sort_order, id').all() as TaskRow[];
}

export function getTask(db: DB, id: number): TaskRow | undefined {
  return db.prepare('SELECT * FROM task WHERE id = ?').get(id) as TaskRow | undefined;
}

export interface TaskInput {
  title: string;
  description?: string | null;
  status?: TaskStatus;
  planned_for?: string | null;
  priority?: TaskPriority;
  due?: string | null;
  notes?: string | null;
  sort_order?: number;
}

function normPriority(v: unknown): TaskPriority {
  return v === 'high' || v === 'mid' || v === 'low' ? v : 'low';
}

export function createTask(db: DB, input: TaskInput): TaskRow {
  const now = Date.now();
  const info = db
    .prepare(
      `INSERT INTO task (title, description, status, planned_for, priority, due, notes, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.title,
      input.description ?? null,
      input.status ?? 'TODO',
      input.planned_for ?? null,
      normPriority(input.priority),
      input.due ?? null,
      input.notes ?? null,
      input.sort_order ?? 0,
      now,
      now,
    );
  return getTask(db, info.lastInsertRowid as number)!;
}

const PATCHABLE = [
  'title',
  'description',
  'status',
  'planned_for',
  'priority',
  'due',
  'notes',
  'sort_order',
] as const;

export function updateTask(
  db: DB,
  id: number,
  patch: Partial<Pick<TaskRow, (typeof PATCHABLE)[number]>>,
): TaskRow | undefined {
  const existing = getTask(db, id);
  if (!existing) return undefined;
  const now = Date.now();
  const fields: string[] = [];
  const params: Record<string, unknown> = { id, now };
  for (const k of PATCHABLE) {
    if (k in patch) {
      fields.push(`${k} = @${k}`);
      params[k] = k === 'priority' ? normPriority(patch[k]) : patch[k];
    }
  }
  // DONE へ遷移したら done_at を刻む（履歴保持）。DONE から離脱で解除。
  if (patch.status === 'DONE' && existing.status !== 'DONE') {
    fields.push('done_at = @now');
  } else if (patch.status && patch.status !== 'DONE') {
    fields.push('done_at = NULL');
  }
  if (fields.length > 0) {
    db.prepare(`UPDATE task SET ${fields.join(', ')}, updated_at = @now WHERE id = @id`).run(params);
  }
  return getTask(db, id);
}

export function deleteTask(db: DB, id: number): boolean {
  return db.prepare('DELETE FROM task WHERE id = ?').run(id).changes > 0;
}
