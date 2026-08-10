import type { DB } from '../db/index.js';
import { createTask, getTask, listTasks, updateTask, type TaskRow } from './tasks.js';

/**
 * タスクツリー（spec: task-tree / goal-blueprint）。
 *
 * 「葉だけがカードになる」「容れ物の完了は導出」「取り込みは追加のみの一方向」の3つを
 * ここに閉じる（design D1〜D10）。
 */

export class TaskTreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskTreeError';
  }
}

// --- 取り込みテキストのパーサ（純関数・DB非依存・design D9） ----------------

export interface ParsedNode {
  title: string;
  notes: string;
  children: ParsedNode[];
}

function leadingWhitespaceLength(line: string): number {
  const m = line.match(/^[ \t]*/);
  return m ? m[0].length : 0;
}

const BULLET_RE = /^[-*]\s*(.*)$/;
const ORDINAL_RE = /^\d+(\.\d+)*\.?\s*/;

export function parseBlueprintText(text: string): ParsedNode[] {
  const lines = text.split('\n');

  // インデント幅は、そのテキスト内で最初に現れたインデント量を1段とする（design D9）。
  let unit = 0;
  for (const line of lines) {
    if (line.trim() === '') continue;
    const ws = leadingWhitespaceLength(line);
    if (ws > 0) {
      unit = ws;
      break;
    }
  }

  const roots: ParsedNode[] = [];
  const stack: ParsedNode[] = []; // stack[depth] = そのdepthで現在開いているノード
  let lastTask: ParsedNode | null = null;

  for (const line of lines) {
    if (line.trim() === '') continue;
    const ws = leadingWhitespaceLength(line);
    const content = line.slice(ws);
    const bulletMatch = content.match(BULLET_RE);

    if (bulletMatch) {
      const rawDepth = unit > 0 ? Math.round(ws / unit) : 0;
      // 段飛ばしは1段だけ深いものとして扱う（拒否しない・design D9）。
      const depth = Math.min(rawDepth, stack.length);
      stack.length = depth;

      const title = bulletMatch[1]!.replace(ORDINAL_RE, '').trim();
      const node: ParsedNode = { title, notes: '', children: [] };
      if (depth === 0) {
        roots.push(node);
      } else {
        stack[depth - 1]!.children.push(node);
      }
      stack.push(node);
      lastTask = node;
    } else if (lastTask) {
      const noteLine = content.trim();
      lastTask.notes = lastTask.notes ? `${lastTask.notes}\n${noteLine}` : noteLine;
    }
    // バレット無しかつタスクがまだ無い行は黙って捨てる（design D9）。
  }

  return roots;
}

// --- 継続チェインの根（design D2） ------------------------------------------

export function resolveLineageRootGoalId(db: DB, goalId: number): number {
  const visited = new Set<number>();
  let current = goalId;
  while (!visited.has(current)) {
    visited.add(current);
    const prev = db
      .prepare('SELECT id FROM goal WHERE continued_goal_id = ?')
      .get(current) as { id: number } | undefined;
    if (!prev) return current;
    current = prev.id;
  }
  return current; // 壊れた循環データに対する防御（実際には作られないはず）
}

// --- 分解（design D5） -------------------------------------------------------

function nextTreeOrder(db: DB, parentId: number | null): number {
  const row =
    parentId === null
      ? (db.prepare('SELECT MAX(tree_order) AS mx FROM task WHERE parent_task_id IS NULL').get() as {
          mx: number | null;
        })
      : (db
          .prepare('SELECT MAX(tree_order) AS mx FROM task WHERE parent_task_id = ?')
          .get(parentId) as { mx: number | null });
  return row.mx == null ? 0 : row.mx + 1;
}

export interface CreateChildInput {
  title: string;
  status?: string;
  notes?: string | null;
  due?: string | null;
}

export function createChildTask(db: DB, parentId: number, input: CreateChildInput): TaskRow {
  const parent = getTask(db, parentId);
  if (!parent) throw new TaskTreeError('親タスクが見つかりません');
  if (parent.status === 'DONE') {
    throw new TaskTreeError('完了済みのタスクは分解できません。先に完了を取り消してください');
  }
  const status = input.status ?? parent.status;
  const treeOrder = nextTreeOrder(db, parentId);
  return createTask(db, {
    title: input.title,
    status,
    notes: input.notes ?? null,
    due: input.due ?? null,
    parent_task_id: parentId,
    tree_order: treeOrder,
  });
}

/**
 * 根（目標直下）へ1件だけ足す（タスク一覧の「＋ 新しい枝を足す」・task-list-inline-edit design D9）。
 * テキスト取り込み（importBlueprint/parseBlueprintText）は経由しない: 行頭の連番読み捨て規則が
 * 素のタイトル入力に対しても働いてしまい、例えば「2つ目のタスク」の先頭の「2」を意図せず削ってしまうため。
 */
export function createRootTask(db: DB, goalId: number, title: string): TaskRow {
  const rootGoalId = resolveLineageRootGoalId(db, goalId);
  return createTask(db, {
    title,
    goal_id: rootGoalId,
    parent_task_id: null,
    tree_order: nextTreeOrder(db, null),
  });
}

// --- 再親付け・循環検査（design D6） ----------------------------------------

/** taskId を parentId の下へ付け替えても循環にならないか検査する（自分自身・自分の子孫は拒否）。 */
function assertNoCycle(db: DB, taskId: number, parentId: number): void {
  if (taskId === parentId) {
    throw new TaskTreeError('自分自身を親にはできません');
  }
  const visited = new Set<number>();
  let current: number | null = parentId;
  while (current !== null) {
    if (current === taskId) {
      throw new TaskTreeError('自分の子孫の下へは付け替えられません');
    }
    if (visited.has(current)) {
      throw new TaskTreeError('親のチェインが壊れています');
    }
    visited.add(current);
    const row = db.prepare('SELECT parent_task_id FROM task WHERE id = ?').get(current) as
      | { parent_task_id: number | null }
      | undefined;
    current = row ? row.parent_task_id : null;
  }
}

export function setParent(db: DB, taskId: number, parentId: number): void {
  assertNoCycle(db, taskId, parentId);
  const treeOrder = nextTreeOrder(db, parentId);
  updateTask(db, taskId, { parent_task_id: parentId, tree_order: treeOrder });
}

/**
 * parentId（親、または null=根）の子（または根）の中で、afterTaskId の直後に置くための
 * tree_order を確保する。afterTaskId が null なら末尾。既存の兄弟の tree_order は
 * MAX+1 で採番された連番の整数（nextTreeOrder）であることを前提に、
 * 挿入位置以降を +1 ずつ後ろへずらす。
 */
function insertOrderAfter(db: DB, parentId: number | null, afterTaskId: number | null): number {
  if (afterTaskId === null) {
    return nextTreeOrder(db, parentId);
  }
  const after = getTask(db, afterTaskId);
  if (!after) {
    return nextTreeOrder(db, parentId);
  }
  const insertOrder = after.tree_order + 1;
  if (parentId === null) {
    db.prepare('UPDATE task SET tree_order = tree_order + 1 WHERE parent_task_id IS NULL AND tree_order >= ?').run(
      insertOrder,
    );
  } else {
    db.prepare(
      'UPDATE task SET tree_order = tree_order + 1 WHERE parent_task_id = ? AND tree_order >= ?',
    ).run(parentId, insertOrder);
  }
  return insertOrder;
}

// --- Enter: 兄弟の追加（design D5） -----------------------------------------

/**
 * 対象の部分木の直後に、同じ深さで1件足す。対象が根なら新しい根（同じ目標を継ぐ）、
 * そうでなければ同じ親の子。status は対象から継ぐ（取り込みの HOLD 固定とは別の操作）。
 */
export function createSiblingTask(db: DB, taskId: number, title: string): TaskRow {
  const target = getTask(db, taskId);
  if (!target) {
    throw new TaskTreeError('対象のタスクが見つかりません');
  }
  const parentId = target.parent_task_id;
  const treeOrder = insertOrderAfter(db, parentId, taskId);
  if (parentId === null) {
    return createTask(db, {
      title,
      status: target.status,
      goal_id: target.goal_id,
      parent_task_id: null,
      tree_order: treeOrder,
    });
  }
  return createTask(db, {
    title,
    status: target.status,
    parent_task_id: parentId,
    tree_order: treeOrder,
  });
}

// --- Tab / Shift+Tab: 階層を1段動かす（design D4） --------------------------

export interface TreePosition {
  parentId: number | null;
  afterTaskId: number | null;
}

/**
 * 対象を部分木ごと1段深く（parentId 指定）／1段浅く（parentId は新しい親、根なら null）動かす。
 * parentId が非 null のときは setParent と同じ循環検査を必ず通す。parentId が null（根へ戻す）
 * ときは、移動前の祖先チェインを辿って根の goal_id を継ぐ（目標を持たない根を作らない）。
 */
export function setTreePosition(db: DB, taskId: number, { parentId, afterTaskId }: TreePosition): void {
  const target = getTask(db, taskId);
  if (!target) {
    throw new TaskTreeError('対象のタスクが見つかりません');
  }
  if (parentId !== null) {
    assertNoCycle(db, taskId, parentId);
    const parent = getTask(db, parentId);
    if (!parent) {
      throw new TaskTreeError('移動先の親が見つかりません');
    }
    const treeOrder = insertOrderAfter(db, parentId, afterTaskId);
    db.prepare(
      'UPDATE task SET parent_task_id = ?, goal_id = NULL, tree_order = ?, updated_at = ? WHERE id = ?',
    ).run(parentId, treeOrder, Date.now(), taskId);
  } else {
    const goalId = findTreeRootGoalId(db, taskId);
    const treeOrder = insertOrderAfter(db, null, afterTaskId);
    db.prepare(
      'UPDATE task SET parent_task_id = NULL, goal_id = ?, tree_order = ?, updated_at = ? WHERE id = ?',
    ).run(goalId, treeOrder, Date.now(), taskId);
  }
}

// --- 取り込み（design D9・追加のみの一方向） --------------------------------

function insertParsedNode(
  db: DB,
  node: ParsedNode,
  parentId: number | null,
  goalId: number | null,
): void {
  const row =
    parentId === null
      ? createTask(db, {
          title: node.title,
          notes: node.notes || null,
          status: 'HOLD',
          goal_id: goalId,
          parent_task_id: null,
          tree_order: nextTreeOrder(db, null),
        })
      : createChildTask(db, parentId, {
          title: node.title,
          notes: node.notes || null,
          status: 'HOLD',
        });
  for (const child of node.children) {
    insertParsedNode(db, child, row.id, null);
  }
}

/** parentTaskId から根まで辿り、根の goal_id を返す（goal_id は根にだけ入る・design D1）。 */
function findTreeRootGoalId(db: DB, taskId: number): number | null {
  let current = getTask(db, taskId);
  if (!current) {
    throw new TaskTreeError('取り込み先のタスクが見つかりません');
  }
  while (current.parent_task_id != null) {
    const parent = getTask(db, current.parent_task_id);
    if (!parent) break;
    current = parent;
  }
  return current.goal_id;
}

export function importBlueprint(
  db: DB,
  goalId: number,
  text: string,
  parentTaskId: number | null = null,
): void {
  if (text.trim() === '') {
    throw new TaskTreeError('取り込むテキストがありません');
  }
  const rootGoalId = resolveLineageRootGoalId(db, goalId);
  if (parentTaskId != null) {
    const treeRootGoalId = findTreeRootGoalId(db, parentTaskId);
    if (treeRootGoalId !== rootGoalId) {
      throw new TaskTreeError('取り込み先は別の目標のツリーに属しています');
    }
  }
  const nodes = parseBlueprintText(text);
  const tx = db.transaction(() => {
    for (const node of nodes) {
      insertParsedNode(db, node, parentTaskId, parentTaskId == null ? rootGoalId : null);
    }
  });
  tx();
}

// --- ツリーの読み出しと完了の導出（design D3・D4） --------------------------

export interface BlueprintNode {
  id: number;
  title: string;
  notes: string | null;
  status: string;
  done: boolean;
  drop_reason: string | null;
  holdLeafCount: number;
  children: BlueprintNode[];
}

export interface Blueprint {
  nodes: BlueprintNode[];
}

export function getBlueprint(db: DB, goalId: number): Blueprint {
  const rootGoalId = resolveLineageRootGoalId(db, goalId);
  const all = listTasks(db);

  const byParent = new Map<number, TaskRow[]>();
  for (const t of all) {
    if (t.parent_task_id == null) continue;
    const arr = byParent.get(t.parent_task_id);
    if (arr) arr.push(t);
    else byParent.set(t.parent_task_id, [t]);
  }
  for (const arr of byParent.values()) {
    arr.sort((a, b) => a.tree_order - b.tree_order || a.id - b.id);
  }

  function build(t: TaskRow): BlueprintNode {
    const children = (byParent.get(t.id) ?? []).map(build);
    const done = children.length > 0 ? children.every((c) => c.done) : t.status === 'DONE';
    const holdLeafCount =
      children.length > 0
        ? children.reduce((sum, c) => sum + c.holdLeafCount, 0)
        : t.status === 'HOLD'
          ? 1
          : 0;
    return {
      id: t.id,
      title: t.title,
      notes: t.notes,
      status: t.status,
      done,
      drop_reason: t.drop_reason,
      holdLeafCount,
      children,
    };
  }

  const roots = all
    .filter((t) => t.parent_task_id == null && t.goal_id === rootGoalId)
    .sort((a, b) => a.tree_order - b.tree_order || a.id - b.id);

  return { nodes: roots.map(build) };
}

// --- 展開規則（design D10・純関数） -----------------------------------------

function findFirstMatchingLeafPath(
  nodes: BlueprintNode[],
  predicate: (n: BlueprintNode) => boolean,
): number[] | null {
  for (const node of nodes) {
    if (node.children.length === 0) {
      if (predicate(node)) return [];
      continue;
    }
    const childPath = findFirstMatchingLeafPath(node.children, predicate);
    if (childPath !== null) return [node.id, ...childPath];
  }
  return null;
}

export function computeOpenPath(nodes: BlueprintNode[]): number[] {
  const doingPath = findFirstMatchingLeafPath(nodes, (n) => n.status === 'DOING');
  if (doingPath !== null) return doingPath;
  const undonePath = findFirstMatchingLeafPath(nodes, (n) => !n.done);
  return undonePath ?? [];
}

// --- 容れ物のチェック / Alt+C: 部分木の一括完了（design D6） ----------------

/**
 * 部分木の葉をまとめて DONE / TODO へ切り替える。対象が葉なら自分1つだけ。
 * 打ち切り済み（drop_reason 非 NULL）の葉はどちらの向きでも動かさない。
 * 容れ物自身の status は書かない（完了は導出のまま）。1回の UPDATE で完結させる。
 */
export function setSubtreeDone(db: DB, taskId: number, done: boolean): void {
  const target = getTask(db, taskId);
  if (!target) {
    throw new TaskTreeError('対象のタスクが見つかりません');
  }
  const leafIds = collectDescendantLeafIds(db, taskId);
  const targetIds = leafIds.length > 0 ? leafIds : [taskId];
  const now = Date.now();
  const placeholders = targetIds.map(() => '?').join(',');
  if (done) {
    db.prepare(
      `UPDATE task SET status = 'DONE', done_at = ?, updated_at = ?
       WHERE id IN (${placeholders}) AND drop_reason IS NULL`,
    ).run(now, now, ...targetIds);
  } else {
    db.prepare(
      `UPDATE task SET status = 'TODO', done_at = NULL, updated_at = ?
       WHERE id IN (${placeholders}) AND drop_reason IS NULL`,
    ).run(now, ...targetIds);
  }
}

// --- 枝への着手・打ち切り（design D7） ---------------------------------------

function collectDescendantLeafIds(db: DB, containerId: number): number[] {
  const all = listTasks(db);
  const byParent = new Map<number, TaskRow[]>();
  for (const t of all) {
    if (t.parent_task_id == null) continue;
    const arr = byParent.get(t.parent_task_id);
    if (arr) arr.push(t);
    else byParent.set(t.parent_task_id, [t]);
  }

  const leaves: number[] = [];
  function walk(id: number): void {
    const children = byParent.get(id) ?? [];
    for (const c of children) {
      const grandchildren = byParent.get(c.id) ?? [];
      if (grandchildren.length === 0) {
        leaves.push(c.id);
      } else {
        walk(c.id);
      }
    }
  }
  walk(containerId);
  return leaves;
}

export function startBranch(db: DB, containerId: number): void {
  const leafIds = collectDescendantLeafIds(db, containerId);
  if (leafIds.length === 0) return;
  const now = Date.now();
  const placeholders = leafIds.map(() => '?').join(',');
  db.prepare(
    `UPDATE task SET status = 'TODO', updated_at = ? WHERE id IN (${placeholders}) AND status = 'HOLD'`,
  ).run(now, ...leafIds);
}

export function dropBranch(db: DB, containerId: number, reason: string): void {
  const trimmed = reason.trim();
  if (trimmed === '') {
    throw new TaskTreeError('打ち切りには理由が必要です');
  }
  const leafIds = collectDescendantLeafIds(db, containerId);
  if (leafIds.length === 0) return;
  const now = Date.now();
  const placeholders = leafIds.map(() => '?').join(',');
  db.prepare(
    `UPDATE task SET status = 'DONE', drop_reason = ?, done_at = ?, updated_at = ?
     WHERE id IN (${placeholders}) AND status <> 'DONE'`,
  ).run(trimmed, now, now, ...leafIds);
}
