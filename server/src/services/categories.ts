import { UNGROUPED_KEY } from '@track/contract';
import type { DB, AppConfigRow } from '../db/index.js';
import { getConfig } from '../db/index.js';

/**
 * 総作業時間の算出（旧カテゴリ層は撤廃：eliminate-categories）。
 * 日×グループの生ミリ秒を合算する。`exclude_ungrouped_from_total` が ON のときのみ
 * 未グループ（`ungrouped` = `UNGROUPED_KEY`）バケットを合算から除外する（spec: work-time-scope）。
 * 除外は「読み出し時」に適用し、`daily_totals_snapshot` の per-group 生データは書き換えない（design.md D1）。
 */

/**
 * 当該グループを日の総作業時間へ算入するかの単一判定（categories/summary/rules で共有）。
 * `exclude_ungrouped_from_total` が ON かつ `UNGROUPED_KEY` 行のときのみ false。実グループは常に true。
 */
export function countsTowardTotal(stableGroupId: string, cfg: AppConfigRow): boolean {
  if (cfg.exclude_ungrouped_from_total === 1 && stableGroupId === UNGROUPED_KEY) return false;
  return true;
}

/** 日の総作業ミリ秒（設定に応じ `ungrouped` を除外可能）。 */
export function totalWorkMsForDay(db: DB, dayKey: string): number {
  const cfg = getConfig(db);
  const rows = db
    .prepare('SELECT stable_group_id AS id, ms FROM daily_totals_snapshot WHERE day_key = ?')
    .all(dayKey) as { id: string; ms: number }[];
  let ms = 0;
  for (const r of rows) if (countsTowardTotal(r.id, cfg)) ms += r.ms;
  return ms;
}

/** 日の総作業秒（整数）。除外規則は totalWorkMsForDay を経由して一貫適用される。 */
export function totalWorkSecondsForDay(db: DB, dayKey: string): number {
  return Math.floor(totalWorkMsForDay(db, dayKey) / 1000);
}
