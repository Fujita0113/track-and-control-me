import type { DB } from '../db/index.js';
import { resolveLineageRootGoalId, collectDescendantLeafIds } from './task-tree.js';
import { addDaysKey } from './day-key.js';
import { todayKey } from './summary.js';
import { resolveGoalMeasurementTarget, accumulatedSecondsForTarget } from './goals.js';
import type { TaskRow } from './tasks.js';

/**
 * 想定時間と小数の進捗（spec: task-estimate）。
 *
 * 想定時間は根直下のノードにだけ置ける（design D4）。進捗は葉にだけ置ける 0〜1 の小数
 * （design D4）。走行中の枝では実測から単価を導き、仮置きを上書きする（design D6）。
 * 変更はどちらも `task_estimate_change` へ理由・実行者つきで1行追記する。
 */

export class TaskEstimateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskEstimateError';
  }
}

type Actor = 'human' | 'agent';

interface TaskEstimateRow {
  id: number;
  parent_task_id: number | null;
  status: string;
  estimated_seconds: number | null;
  progress_ratio: number | null;
  drop_reason: string | null;
  done_at: number | null;
}

function getTaskRow(db: DB, id: number): TaskEstimateRow | undefined {
  return db
    .prepare('SELECT id, parent_task_id, status, estimated_seconds, progress_ratio, drop_reason, done_at FROM task WHERE id = ?')
    .get(id) as TaskEstimateRow | undefined;
}

function requireReason(reason: string): string {
  const trimmed = String(reason ?? '').trim();
  if (!trimmed) throw new TaskEstimateError('理由を入力してください');
  return trimmed;
}

function requireActor(actor: unknown): Actor {
  if (actor !== 'human' && actor !== 'agent') throw new TaskEstimateError('実行者は human/agent のいずれかにしてください');
  return actor;
}

function logChange(
  db: DB,
  args: { taskId: number; field: 'estimate' | 'progress'; fromValue: number | null; toValue: number; reason: string; actor: Actor; dayKey: string; createdAt: number },
): void {
  db.prepare(
    `INSERT INTO task_estimate_change (task_id, field, from_value, to_value, reason, actor, day_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(args.taskId, args.field, args.fromValue, args.toValue, args.reason, args.actor, args.dayKey, args.createdAt);
}

export interface SetTaskEstimateInput {
  estimatedSeconds: number;
  reason: string;
  actor: Actor;
}

/** 根直下のノードにだけ想定時間を置ける（design D4）。負値・空の理由は拒否する。 */
export function setTaskEstimate(db: DB, taskId: number, input: SetTaskEstimateInput, nowMs = Date.now()): void {
  const task = getTaskRow(db, taskId);
  if (!task) throw new TaskEstimateError('タスクが見つかりません');
  if (task.parent_task_id !== null) throw new TaskEstimateError('想定時間は根直下のノードにだけ置けます');
  if (!(typeof input.estimatedSeconds === 'number' && Number.isFinite(input.estimatedSeconds) && input.estimatedSeconds >= 0))
    throw new TaskEstimateError('想定時間は0以上で指定してください');
  const reason = requireReason(input.reason);
  const actor = requireActor(input.actor);
  const dayKey = todayKey(db, nowMs);

  const tx = db.transaction(() => {
    db.prepare('UPDATE task SET estimated_seconds = ?, updated_at = ? WHERE id = ?').run(
      input.estimatedSeconds,
      nowMs,
      taskId,
    );
    logChange(db, {
      taskId,
      field: 'estimate',
      fromValue: task.estimated_seconds,
      toValue: input.estimatedSeconds,
      reason,
      actor,
      dayKey,
      createdAt: nowMs,
    });
  });
  tx();
}

export interface SetTaskProgressInput {
  ratio: number;
  reason: string;
  actor: Actor;
}

/** 葉にだけ小数の進捗を置ける（design D4）。範囲外（0未満／1超）・空の理由は拒否する。 */
export function setTaskProgress(db: DB, taskId: number, input: SetTaskProgressInput, nowMs = Date.now()): void {
  const task = getTaskRow(db, taskId);
  if (!task) throw new TaskEstimateError('タスクが見つかりません');
  const hasChild = db.prepare('SELECT 1 FROM task WHERE parent_task_id = ?').get(taskId);
  if (hasChild) throw new TaskEstimateError('進捗は葉にだけ置けます');
  if (!(typeof input.ratio === 'number' && Number.isFinite(input.ratio) && input.ratio >= 0 && input.ratio <= 1))
    throw new TaskEstimateError('進捗は0〜1で指定してください');
  const reason = requireReason(input.reason);
  const actor = requireActor(input.actor);
  const dayKey = todayKey(db, nowMs);

  const tx = db.transaction(() => {
    db.prepare('UPDATE task SET progress_ratio = ?, updated_at = ? WHERE id = ?').run(input.ratio, nowMs, taskId);
    logChange(db, {
      taskId,
      field: 'progress',
      fromValue: task.progress_ratio,
      toValue: input.ratio,
      reason,
      actor,
      dayKey,
      createdAt: nowMs,
    });
  });
  tx();
}

// --- 根直下の枝（design D5・D6） --------------------------------------------

function orderedRootBranches(db: DB, goalId: number): TaskRow[] {
  const rootGoalId = resolveLineageRootGoalId(db, goalId);
  return db
    .prepare('SELECT * FROM task WHERE parent_task_id IS NULL AND goal_id = ? ORDER BY tree_order, id')
    .all(rootGoalId) as TaskRow[];
}

/** 枝の非打ち切り葉（drop_reason IS NULL）。打ち切り済みは消化量にも残りにも数えない。 */
function activeLeavesOf(db: DB, rootId: number): TaskEstimateRow[] {
  const leafIds = collectDescendantLeafIds(db, rootId);
  if (leafIds.length === 0) return [];
  const placeholders = leafIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT id, parent_task_id, status, estimated_seconds, progress_ratio, drop_reason, done_at
         FROM task WHERE id IN (${placeholders})`,
    )
    .all(...leafIds) as TaskEstimateRow[];
  return rows.filter((r) => r.drop_reason == null);
}

/** 葉1件の消化量（完了=1.0／小数の進捗／未設定=0）。 */
function leafWeight(leaf: TaskEstimateRow): number {
  if (leaf.status === 'DONE') return 1.0;
  return leaf.progress_ratio ?? 0;
}

interface BranchWindow {
  taskId: number;
  startDay: string;
  leaves: TaskEstimateRow[];
  settled: boolean;
}

/**
 * 根直下の枝を tree_order 順に走査し、各枝の開始日（design D5: 直前の枝が決着した日の翌日、
 * 無ければ目標の start_day）と決着状態を求める。走行中／未走の枝の開始日は以降の枝の
 * 決着計算には使われないため厳密でなくてよい。
 */
function branchWindows(db: DB, goalId: number, nowMs: number): BranchWindow[] {
  const goalRow = db.prepare('SELECT start_day FROM goal WHERE id = ?').get(goalId) as { start_day: string } | undefined;
  if (!goalRow) return [];
  const branches = orderedRootBranches(db, goalId);
  const out: BranchWindow[] = [];
  let cursorStart = goalRow.start_day;
  for (const b of branches) {
    const leaves = activeLeavesOf(db, b.id);
    const hasUndecided = leaves.some((l) => l.status !== 'DONE');
    const startDay = cursorStart;
    out.push({ taskId: b.id, startDay, leaves, settled: !hasUndecided });
    if (!hasUndecided) {
      const doneAts = leaves.map((l) => l.done_at).filter((x): x is number => x != null);
      const settleDay = doneAts.length ? todayKey(db, Math.max(...doneAts)) : startDay;
      cursorStart = addDaysKey(settleDay, 1);
    }
  }
  return out;
}

export interface RunningBranchView {
  taskId: number;
  startDay: string;
}

/** 未決着の葉を持つ最初の根直下の枝（design D5）。無ければ null（走行中の枝は高々1つ）。 */
export function runningBranch(db: DB, goalId: number, nowMs = Date.now()): RunningBranchView | null {
  const windows = branchWindows(db, goalId, nowMs);
  const running = windows.find((w) => !w.settled);
  return running ? { taskId: running.taskId, startDay: running.startDay } : null;
}

export interface BranchRemainingView {
  taskId: number;
  consumed: number;
  remainingLeafWeight: number;
  unitSeconds: number | null;
  remainingSeconds: number;
  source: 'measured' | 'placeholder' | 'none';
}

export interface BranchRemainingOpts {
  all?: boolean;
}

/**
 * 枝の残り想定（design D6）。既定は走行中の枝、`opts.all` で根直下の全枝を返す。
 * 消化量0（未着手）は仮置きをそのまま使う（`source: 'placeholder'`）。消化量>0 は
 * 枝の開始日〜今日の実測から単価を導き、上書きする（`source: 'measured'`）。
 */
export function branchRemaining(
  db: DB,
  goalId: number,
  nowMs?: number,
  opts?: { all?: false },
): BranchRemainingView | null;
export function branchRemaining(
  db: DB,
  goalId: number,
  nowMs: number | undefined,
  opts: { all: true },
): BranchRemainingView[];
export function branchRemaining(
  db: DB,
  goalId: number,
  nowMs = Date.now(),
  opts: BranchRemainingOpts = {},
): BranchRemainingView | BranchRemainingView[] | null {
  const windows = branchWindows(db, goalId, nowMs);
  const target = resolveGoalMeasurementTarget(db, goalId);
  const today = todayKey(db, nowMs);

  const compute = (w: BranchWindow): BranchRemainingView => {
    const row = db.prepare('SELECT estimated_seconds FROM task WHERE id = ?').get(w.taskId) as
      | { estimated_seconds: number | null }
      | undefined;
    const estimatedSeconds = row?.estimated_seconds ?? null;
    const consumed = w.leaves.reduce((sum, l) => sum + leafWeight(l), 0);
    const remainingLeafWeight = w.leaves.length - consumed;

    if (estimatedSeconds == null) {
      return { taskId: w.taskId, consumed, remainingLeafWeight, unitSeconds: null, remainingSeconds: 0, source: 'none' };
    }
    if (consumed === 0) {
      return {
        taskId: w.taskId,
        consumed,
        remainingLeafWeight,
        unitSeconds: null,
        remainingSeconds: estimatedSeconds,
        source: 'placeholder',
      };
    }
    // 消化量 > 0: 枝の開始日〜今日の実測から単価を導く（先の枝でも remainingLeafWeight=0 のときは
    // 単価の値自体は結果に影響しない）。
    const measuredSeconds = target ? accumulatedSecondsForTarget(db, target, dayKeysBetween(w.startDay, today)) : 0;
    const unitSeconds = measuredSeconds / consumed;
    const remainingSeconds = unitSeconds * remainingLeafWeight;
    return { taskId: w.taskId, consumed, remainingLeafWeight, unitSeconds, remainingSeconds, source: 'measured' };
  };

  if (opts.all) return windows.map(compute);
  const running = windows.find((w) => !w.settled);
  return running ? compute(running) : null;
}

function dayKeysBetween(fromDay: string, toDay: string): string[] {
  if (toDay < fromDay) return [];
  const out: string[] = [];
  let cursor = fromDay;
  while (cursor <= toDay) {
    out.push(cursor);
    cursor = addDaysKey(cursor, 1);
  }
  return out;
}

/** 根直下の残りの単純和（design D6・task-list-inline-edit の非侵襲原則に合わせ推測で埋めない）。 */
export function remainingScopeSeconds(db: DB, goalId: number, nowMs = Date.now()): number | null {
  const rows = branchRemaining(db, goalId, nowMs, { all: true });
  const withEstimate = rows.filter((r) => r.source !== 'none');
  if (withEstimate.length === 0) return null;
  return withEstimate.reduce((sum, r) => sum + r.remainingSeconds, 0);
}
