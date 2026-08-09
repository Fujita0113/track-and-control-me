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

// --- 再親付け・循環検査（design D6） ----------------------------------------

export function setParent(db: DB, taskId: number, parentId: number): void {
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
  const treeOrder = nextTreeOrder(db, parentId);
  updateTask(db, taskId, { parent_task_id: parentId, tree_order: treeOrder });
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

export function importBlueprint(db: DB, goalId: number, text: string): void {
  if (text.trim() === '') {
    throw new TaskTreeError('取り込むテキストがありません');
  }
  const rootGoalId = resolveLineageRootGoalId(db, goalId);
  const nodes = parseBlueprintText(text);
  const tx = db.transaction(() => {
    for (const node of nodes) {
      insertParsedNode(db, node, null, rootGoalId);
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
    return {
      id: t.id,
      title: t.title,
      notes: t.notes,
      status: t.status,
      done,
      drop_reason: t.drop_reason,
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
