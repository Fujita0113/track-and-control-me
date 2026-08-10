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
  /** 1 = 手動指定でロック（自動 due 上書き対象外）。既定 0。 */
  due_locked: number;
  notes: string | null;
  sort_order: number;
  /**
   * カテゴリ（kanban-task-category, design D1〜D3）。UUID照合＋名前色スナップショットの両持ち。
   * category_group_id … 照合キー＝タブグループの stable_group_id（自由入力/その他は null）。
   * category_name/color … 付与当時の表示スナップショット（グループ改名・改色でも書き換えない）。
   */
  category_group_id: string | null;
  category_name: string | null;
  category_color: string | null;
  created_at: number;
  done_at: number | null;
  updated_at: number;
  /**
   * タスクツリー（task-tree, design D1）。parent_task_id が NULL のタスクを根と呼ぶ。
   * goal_id は根にだけ入る（子は親を辿れば分かる・design D1）。
   * drop_reason は非 NULL で「打ち切り」を表す（status='DONE' に相乗り・design D7）。
   */
  parent_task_id: number | null;
  goal_id: number | null;
  tree_order: number;
  drop_reason: string | null;
  /** listTasks 限定で付与（design D3）。1 = 子を持つ「容れ物」。getTask/createTask の戻り値には無い。 */
  has_children?: number;
  /**
   * listTasks 限定で付与（task-list-card-tree-ui design D2・D3）。カンバンのパンくず帯が使う。
   * root_task_id … 根まで辿った先の id（根自身は自分）。同じ枝の葉は同じ値を持つ。
   * goal_name … その根の継続チェインの根の目標名。目標に属さない根の子は null。
   */
  root_task_id?: number;
  goal_name?: string | null;
}

export function listTasks(db: DB): TaskRow[] {
  return db
    .prepare(
      `WITH RECURSIVE
         task_root(id, root_id) AS (
           SELECT id, id FROM task WHERE parent_task_id IS NULL
           UNION ALL
           SELECT t.id, tr.root_id FROM task t JOIN task_root tr ON t.parent_task_id = tr.id
         ),
         goal_lineage(id, root_id) AS (
           SELECT id, id FROM goal
           UNION ALL
           SELECT gl.id, g.id FROM goal_lineage gl JOIN goal g ON g.continued_goal_id = gl.root_id
         ),
         goal_root(id, root_id) AS (
           SELECT id, root_id FROM goal_lineage gl
           WHERE NOT EXISTS (SELECT 1 FROM goal g WHERE g.continued_goal_id = gl.root_id)
         )
       SELECT task.*,
              EXISTS(SELECT 1 FROM task c WHERE c.parent_task_id = task.id) AS has_children,
              tr.root_id AS root_task_id,
              rg.name AS goal_name
       FROM task
       JOIN task_root tr ON tr.id = task.id
       LEFT JOIN task root_task ON root_task.id = tr.root_id
       LEFT JOIN goal_root gr ON gr.id = root_task.goal_id
       LEFT JOIN goal rg ON rg.id = gr.root_id
       ORDER BY status, sort_order, task.id`,
    )
    .all() as TaskRow[];
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
  due_locked?: number;
  notes?: string | null;
  sort_order?: number;
  /** カテゴリ（両持ち）。付与時のみ指定。未指定はカテゴリ無しのまま。 */
  category_group_id?: string | null;
  category_name?: string | null;
  category_color?: string | null;
  /** タスクツリー（task-tree）。未指定は根＝現状と同じ挙動。 */
  parent_task_id?: number | null;
  goal_id?: number | null;
  tree_order?: number;
}

function normPriority(v: unknown): TaskPriority {
  return v === 'high' || v === 'mid' || v === 'low' ? v : 'low';
}

export function createTask(db: DB, input: TaskInput): TaskRow {
  const now = Date.now();
  const status = input.status ?? 'TODO';
  // sort_order 未指定時は当該 status 列の末尾ランク（MAX+1、無ければ 0）をサーバ側で採番する。
  // これにより全カードが 0 で衝突する状態を作らず、新規カードは列末尾に一意に並ぶ（design D5）。
  let sortOrder = input.sort_order;
  if (sortOrder == null) {
    const row = db.prepare('SELECT MAX(sort_order) AS mx FROM task WHERE status = ?').get(status) as {
      mx: number | null;
    };
    sortOrder = row.mx == null ? 0 : row.mx + 1;
  }
  const info = db
    .prepare(
      `INSERT INTO task (title, description, status, planned_for, priority, due, due_locked, notes, sort_order,
                         category_group_id, category_name, category_color,
                         parent_task_id, goal_id, tree_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.title,
      input.description ?? null,
      status,
      input.planned_for ?? null,
      normPriority(input.priority),
      input.due ?? null,
      input.due_locked ? 1 : 0,
      input.notes ?? null,
      sortOrder,
      input.category_group_id ?? null,
      input.category_name ?? null,
      input.category_color ?? null,
      input.parent_task_id ?? null,
      input.goal_id ?? null,
      input.tree_order ?? 0,
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
  'due_locked',
  'notes',
  'sort_order',
  // カテゴリ3列。付与・変更・除去（NULL化）を許可（両持ちで焼き込み。design D1〜D3）。
  'category_group_id',
  'category_name',
  'category_color',
  // タスクツリー（task-tree）。parent_task_id の変更は呼び出し側で setParent の循環検査を通すこと（design D6）。
  'parent_task_id',
  'tree_order',
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
      params[k] =
        k === 'priority'
          ? normPriority(patch[k])
          : k === 'due_locked'
            ? patch[k]
              ? 1
              : 0
            : patch[k];
    }
  }
  // DONE へ遷移したら done_at を刻む（履歴保持）。DONE から離脱で解除。
  // 離脱時は drop_reason も解除する（打ち切りではなく、未着手へ戻ったことになるため・design D7）。
  if (patch.status === 'DONE' && existing.status !== 'DONE') {
    fields.push('done_at = @now');
  } else if (patch.status && patch.status !== 'DONE') {
    fields.push('done_at = NULL');
    fields.push('drop_reason = NULL');
  }
  if (fields.length > 0) {
    db.prepare(`UPDATE task SET ${fields.join(', ')}, updated_at = @now WHERE id = @id`).run(params);
  }
  return getTask(db, id);
}

/**
 * 削除は子を道連れにしない（task-tree, design D8）。子は「削除される行の親」へ繰り上げ、
 * 根へ上がる場合（消える行が根だった場合）は、消える行の goal_id を子へ配る。
 * ON DELETE CASCADE を付けていないため、繰り上げは行の削除前にアプリ側で行う。
 */
export function deleteTask(db: DB, id: number): boolean {
  const existing = getTask(db, id);
  if (!existing) return false;
  const tx = db.transaction(() => {
    if (existing.parent_task_id === null) {
      db.prepare('UPDATE task SET parent_task_id = NULL, goal_id = ? WHERE parent_task_id = ?').run(
        existing.goal_id,
        id,
      );
    } else {
      db.prepare('UPDATE task SET parent_task_id = ? WHERE parent_task_id = ?').run(
        existing.parent_task_id,
        id,
      );
    }
    db.prepare('DELETE FROM task WHERE id = ?').run(id);
  });
  tx();
  return true;
}

/** 並べ替えの 1 列分：この status 列を ids の順に並べる（sort_order = 0,1,2,…）。 */
export interface ReorderGroup {
  status: TaskStatus;
  ids: number[];
}

/**
 * 列単位の連番再インデックス（design D1/D2）。
 * 影響列ごとに ids[i] のタスクへ sort_order = i を設定し、status も当該キーへ更新する
 * （既存カードの全 0 衝突を正規化しつつ、列間移動の status 変更も同時に反映）。
 * DONE への遷移は本関数の対象外（完了はアーカイブ経路 completeTask 側で処理）。
 * 1 トランザクション内で atomic に適用する。
 */
export function reorderTasks(db: DB, order: ReorderGroup[]): void {
  const now = Date.now();
  const upd = db.prepare(
    'UPDATE task SET sort_order = @sort_order, status = @status, updated_at = @now WHERE id = @id',
  );
  const tx = db.transaction((groups: ReorderGroup[]) => {
    for (const g of groups) {
      g.ids.forEach((id, i) => {
        upd.run({ id, sort_order: i, status: g.status, now });
      });
    }
  });
  tx(order);
}
