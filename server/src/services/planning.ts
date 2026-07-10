import type { DB } from '../db/index.js';
import { getConfig } from '../db/index.js';
import { nextDayKey } from '../aggregation/index.js';

/**
 * 「翌日計画完了」シグナル（PLANNING）。既定は「当日の振り返り記録済み」かつ
 * 「翌日タスク >= N」。F7（reflection_entry / task / planning_status）が未導入でも
 * テーブル存在チェックで安全に false を返す（MVP は MANUAL_CHECK で代替）。
 */

function tableExists(db: DB, name: string): boolean {
  const r = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as unknown;
  return r !== undefined;
}

function columnExists(db: DB, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return rows.some((r) => r.name === column);
}

export interface PlanningSignal {
  planningDone: boolean;
  reflectionDone: boolean;
  tomorrowTaskCount: number;
}

export function getPlanningSignal(db: DB, dayKey: string): PlanningSignal {
  const cfg = getConfig(db);
  const requireReflection = cfg.planning_require_reflection === 1;
  const minTasks = cfg.planning_min_tomorrow_tasks;

  let reflectionDone = false;
  if (tableExists(db, 'reflection_entry')) {
    const r = db
      .prepare('SELECT content FROM reflection_entry WHERE date = ?')
      .get(dayKey) as { content: string } | undefined;
    reflectionDone = !!r && r.content.trim().length > 0;
  }

  let tomorrowTaskCount = 0;
  if (tableExists(db, 'task')) {
    const tomorrow = nextDayKey(dayKey);
    // PLANNING 契約: 翌日を「予定日(planned_for)」または「期限(due)」とする未完了タスク数。
    // カンバンは期限ベースで管理するため、due=翌日 でも PLANNING を満たせる（design D4）。
    // `due` は v5 で追加のため、カラム存在をガードして後方互換にする。
    const hasDue = columnExists(db, 'task', 'due');
    const sql = hasDue
      ? "SELECT COUNT(*) AS c FROM task WHERE (planned_for = ? OR due = ?) AND status <> 'DONE'"
      : "SELECT COUNT(*) AS c FROM task WHERE planned_for = ? AND status <> 'DONE'";
    const c = (hasDue
      ? db.prepare(sql).get(tomorrow, tomorrow)
      : db.prepare(sql).get(tomorrow)) as { c: number };
    tomorrowTaskCount = c.c;
  }

  const planningDone = (!requireReflection || reflectionDone) && tomorrowTaskCount >= minTasks;
  return { planningDone, reflectionDone, tomorrowTaskCount };
}

/**
 * PLANNING 条件の `signal_key` → 単独ブールシグナルの中央レジストリ
 * （kanban-rule-conditions D1/D2）。`evaluateDay` はこれ 1 箇所を呼ぶ。
 *
 * - `reflection_done`: 当日の振り返り本文が非空（= 既存 `reflectionDone`）。
 * - `tomorrow_tasks_registered`: 翌日対象の未完了タスク数 >= `planning_min_tomorrow_tasks`。
 * - `tomorrow_planned`: 既存合成 `planningDone`（振り返り AND 翌日タスク≥N）。
 * - `null`: 後方互換で `tomorrow_planned` として評価（既存 signal_key 未設定条件）。
 * - 未知キー: 安全側で false ＋ 警告（誤解錠しない）。
 */
export const PLANNING_SIGNAL_KEYS = [
  'tomorrow_planned',
  'reflection_done',
  'tomorrow_tasks_registered',
] as const;
export type PlanningSignalKey = (typeof PLANNING_SIGNAL_KEYS)[number];

export function resolvePlanningSignal(db: DB, dayKey: string, signalKey: string | null): boolean {
  const sig = getPlanningSignal(db, dayKey);
  switch (signalKey) {
    case null:
    case 'tomorrow_planned':
      return sig.planningDone;
    case 'reflection_done':
      return sig.reflectionDone;
    case 'tomorrow_tasks_registered':
      return sig.tomorrowTaskCount >= getConfig(db).planning_min_tomorrow_tasks;
    default:
      console.warn(`[planning] 未知の signal_key=${JSON.stringify(signalKey)} → false（非解錠）`);
      return false;
  }
}

/** planning_status を materialize（task 9.3）。シグナルを返す。 */
export function refreshPlanningStatus(db: DB, dayKey: string, nowMs = Date.now()): PlanningSignal {
  const sig = getPlanningSignal(db, dayKey);
  if (tableExists(db, 'planning_status')) {
    db.prepare(
      `INSERT INTO planning_status (date, reflection_done, tomorrow_task_count, planning_done, evaluated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(date) DO UPDATE SET
         reflection_done = excluded.reflection_done,
         tomorrow_task_count = excluded.tomorrow_task_count,
         planning_done = excluded.planning_done,
         evaluated_at = excluded.evaluated_at`,
    ).run(
      dayKey,
      sig.reflectionDone ? 1 : 0,
      sig.tomorrowTaskCount,
      sig.planningDone ? 1 : 0,
      nowMs,
    );
  }
  return sig;
}
