import type { DB } from '../db/index.js';

/**
 * 総作業時間の算出（旧カテゴリ層は撤廃：eliminate-categories）。
 * 日×グループの生秒数を全グループ（`ungrouped` 含む）で合算するのみ。
 * counts_toward_total / WORK-AWAY フィルタは廃止。
 */

/** 日の総作業ミリ秒（全グループ合算、`ungrouped` 含む）。 */
export function totalWorkMsForDay(db: DB, dayKey: string): number {
  const row = db
    .prepare('SELECT COALESCE(SUM(ms), 0) AS ms FROM daily_totals_snapshot WHERE day_key = ?')
    .get(dayKey) as { ms: number };
  return row.ms;
}

/** 日の総作業秒（整数）。 */
export function totalWorkSecondsForDay(db: DB, dayKey: string): number {
  return Math.floor(totalWorkMsForDay(db, dayKey) / 1000);
}
