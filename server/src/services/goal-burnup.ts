import type { DB } from '../db/index.js';
import { addDaysKey, dayDiff } from './day-key.js';
import { getGoal, resolveGoalMeasurementTarget, dailySecondsForTarget } from './goals.js';
import { todayKey } from './summary.js';
import { resolveLineageRootGoalId, collectDescendantLeafIds } from './task-tree.js';
import { remainingScopeSeconds } from './task-estimate.js';
import type { TaskRow } from './tasks.js';

/**
 * 進捗グラフ（バーンアップ）の算定（spec: goal-burnup / design.md D2〜D13）。
 *
 * 縦軸＝累積作業時間・横軸＝日付。累積線と残り想定時間から2本の完了予想（全体平均／直近3日）を出す。
 * 凍結日は除外せず 0h の実績として暦どおり数える（design D3）。予測の推移は追跡しない
 * （今日1時点の2ペースだけを返す）。クライアントは描画に徹する（`kakeibo-forecast` と同じ方針）。
 */

export interface BurnupPoint {
  dayKey: string;
  accumulatedSeconds: number;
}

export interface BurnupPace {
  averageSecondsPerDay: number;
  /** null = 予測しない（ペース0・想定なし・完走後・終了後）。 */
  projectedDay: string | null;
}

export interface ScopeChange {
  dayKey: string;
  fromSeconds: number | null;
  toSeconds: number;
  reason: string;
  actor: string;
}

export interface BurnupTarget {
  labels: string[];
}

export interface AchievementLeaf {
  taskId: number;
  title: string;
  done: boolean;
  dayKey: string | null;
}

export interface AchievementBranch {
  taskId: number;
  title: string;
  /** true=完了（黒丸）／false=走行中（白丸）。未着手の枝はそもそも配列に含めない（design D11）。 */
  completed: boolean;
  /** 完了は完了日、走行中は今日。 */
  dayKey: string;
  /** 走行中の枝の葉一覧（クリックでモーダル表示用）。完了した枝は空配列。 */
  leaves: AchievementLeaf[];
}

export interface AchievementLeafGroup {
  dayKey: string;
  leaves: { taskId: number; title: string }[];
}

export interface AchievementMarkers {
  branches: AchievementBranch[];
  /** 走行中の枝で完了した葉。同じ日は1グループにまとめる（design D11）。 */
  leafCompletions: AchievementLeafGroup[];
}

export interface GoalBurnupView {
  goalId: number;
  startDay: string;
  endDay: string;
  points: BurnupPoint[];
  /** 根直下の残り想定の単純和。想定が1件も無ければ null（design D6）。 */
  remainingSeconds: number | null;
  overall: BurnupPace;
  recent3: BurnupPace;
  scopeChanges: ScopeChange[];
  target: BurnupTarget | null;
  markers: AchievementMarkers;
}

function dayKeysBetween(fromDay: string, toDay: string): string[] {
  if (toDay < fromDay) return [];
  const n = dayDiff(fromDay, toDay);
  const out: string[] = [];
  for (let i = 0; i <= n; i++) out.push(addDaysKey(fromDay, i));
  return out;
}

/** 完了予想日＝今日 + 切り上げた残り日数。ペース0・想定なしは null（0除算の値を返さない）。 */
function projectDay(today: string, remainingSeconds: number | null, averageSecondsPerDay: number): string | null {
  if (remainingSeconds == null) return null;
  if (remainingSeconds <= 0) return today;
  if (averageSecondsPerDay <= 0) return null;
  return addDaysKey(today, Math.ceil(remainingSeconds / averageSecondsPerDay));
}

function scopeChangesFor(db: DB, goalId: number): ScopeChange[] {
  const rootGoalId = resolveLineageRootGoalId(db, goalId);
  const branchIds = (
    db.prepare('SELECT id FROM task WHERE parent_task_id IS NULL AND goal_id = ?').all(rootGoalId) as {
      id: number;
    }[]
  ).map((r) => r.id);
  if (branchIds.length === 0) return [];
  const placeholders = branchIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT day_key, from_value, to_value, reason, actor FROM task_estimate_change
       WHERE field = 'estimate' AND task_id IN (${placeholders}) ORDER BY day_key, id`,
    )
    .all(...branchIds) as { day_key: string; from_value: number | null; to_value: number; reason: string; actor: string }[];
  return rows.map((r) => ({
    dayKey: r.day_key,
    fromSeconds: r.from_value,
    toSeconds: r.to_value,
    reason: r.reason,
    actor: r.actor,
  }));
}

/**
 * タスク達成マーカー（design D11）。根直下の枝を tree_order 順に見て、完了済みの枝は黒丸、
 * 最初に見つかった未決着の枝（走行中）は白丸＋葉一覧を返し、そこで止める（design D5:
 * 走行中の枝は高々1つ。それより後ろの枝は「未着手」＝何も描かない）。
 */
function achievementMarkersFor(db: DB, goalId: number, nowMs: number): AchievementMarkers {
  const today = todayKey(db, nowMs);
  const rootGoalId = resolveLineageRootGoalId(db, goalId);
  const branches = db
    .prepare('SELECT * FROM task WHERE parent_task_id IS NULL AND goal_id = ? ORDER BY tree_order, id')
    .all(rootGoalId) as TaskRow[];

  const branchMarkers: AchievementBranch[] = [];
  const leafCompletions: AchievementLeafGroup[] = [];

  for (const b of branches) {
    const leafIds = collectDescendantLeafIds(db, b.id);
    const leafRows = leafIds.length
      ? (db
          .prepare(`SELECT * FROM task WHERE id IN (${leafIds.map(() => '?').join(',')})`)
          .all(...leafIds) as TaskRow[])
      : [];
    const active = leafRows.filter((l) => l.drop_reason == null);
    const hasUndecided = active.some((l) => l.status !== 'DONE');

    if (hasUndecided) {
      branchMarkers.push({
        taskId: b.id,
        title: b.title,
        completed: false,
        dayKey: today,
        leaves: active.map((l) => ({
          taskId: l.id,
          title: l.title,
          done: l.status === 'DONE',
          dayKey: l.status === 'DONE' && l.done_at != null ? todayKey(db, l.done_at) : null,
        })),
      });
      const byDay = new Map<string, { taskId: number; title: string }[]>();
      for (const l of active) {
        if (l.status !== 'DONE' || l.done_at == null) continue;
        const dk = todayKey(db, l.done_at);
        if (!byDay.has(dk)) byDay.set(dk, []);
        byDay.get(dk)!.push({ taskId: l.id, title: l.title });
      }
      for (const [dk, leaves] of [...byDay].sort(([a], [b2]) => (a < b2 ? -1 : a > b2 ? 1 : 0))) {
        leafCompletions.push({ dayKey: dk, leaves });
      }
      break; // 走行中の枝で止める。以降は未着手（design D11: 何も描かない）。
    }

    const doneLeaves = active.filter((l) => l.status === 'DONE');
    if (doneLeaves.length === 0) continue; // 葉が1つも無い（or 全打ち切り）枝は時間軸上の根拠が無い。

    const doneAts = doneLeaves.map((l) => l.done_at).filter((x): x is number => x != null);
    const dayKey = doneAts.length ? todayKey(db, Math.max(...doneAts)) : today;
    branchMarkers.push({ taskId: b.id, title: b.title, completed: true, dayKey, leaves: [] });
  }

  return { branches: branchMarkers, leafCompletions };
}

/**
 * 目標のバーンアップを算定する。開始前（`today < start_day`）は null（API は 409）。
 * 完走後・終了後も開けるが、完了予想（`projectedDay`）は出さない（累積線とマーカーは出す）。
 */
export function goalBurnup(db: DB, goalId: number, nowMs = Date.now()): GoalBurnupView | null {
  const view = getGoal(db, goalId, nowMs);
  if (view.status === 'upcoming') return null;
  const today = todayKey(db, nowMs);

  const target = resolveGoalMeasurementTarget(db, goalId);
  let points: BurnupPoint[] = [];
  let elapsedDays = 0;
  let totalAccumulated = 0;
  let dailyMap = new Map<string, number>();
  let dayKeys: string[] = [];
  if (target) {
    dayKeys = dayKeysBetween(view.startDay, today);
    dailyMap = dailySecondsForTarget(db, target, dayKeys);
    let cum = 0;
    points = dayKeys.map((dk) => {
      cum += dailyMap.get(dk) ?? 0;
      return { dayKey: dk, accumulatedSeconds: cum };
    });
    totalAccumulated = cum;
    elapsedDays = dayKeys.length;
  }

  const overallAvg = elapsedDays > 0 ? Math.floor(totalAccumulated / elapsedDays) : 0;
  const recentDays = dayKeys.slice(-3);
  const recentSum = recentDays.reduce((s, dk) => s + (dailyMap.get(dk) ?? 0), 0);
  const recentAvg = recentDays.length > 0 ? Math.floor(recentSum / recentDays.length) : 0;

  const remainingSeconds = remainingScopeSeconds(db, goalId, nowMs);
  const canProject = view.status === 'active';

  return {
    goalId,
    startDay: view.startDay,
    endDay: view.endDay,
    points,
    remainingSeconds,
    overall: {
      averageSecondsPerDay: overallAvg,
      projectedDay: canProject ? projectDay(today, remainingSeconds, overallAvg) : null,
    },
    recent3: {
      averageSecondsPerDay: recentAvg,
      projectedDay: canProject ? projectDay(today, remainingSeconds, recentAvg) : null,
    },
    scopeChanges: scopeChangesFor(db, goalId),
    target: target ? { labels: target.labels } : null,
    markers: achievementMarkersFor(db, goalId, nowMs),
  };
}
