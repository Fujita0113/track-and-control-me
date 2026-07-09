import type { DB } from '../db/index.js';
import { getConfig } from '../db/index.js';
import { recompute } from './recompute.js';
import { dayKeyFor } from '../aggregation/index.js';
import { evaluateDay } from '../rules/evaluate.js';
import { maybeAutoReveal } from '../password/reveal.js';

/**
 * ingest → 再計算 → ルール評価/latch → 達成瞬間の自動 reveal を1本にまとめた
 * ダウンストリーム処理。ingest のデバウンス、定期評価、日境界 finalize から呼ぶ。
 */
export interface PipelineResult {
  today: string;
  changedDays: string[];
}

export function runPipeline(db: DB, nowMs = Date.now()): PipelineResult {
  const cfg = getConfig(db);
  const today = dayKeyFor(nowMs, cfg.tz, cfg.day_boundary_minutes);
  const yesterday = dayKeyFor(nowMs - 24 * 3600_000, cfg.tz, cfg.day_boundary_minutes);

  // 変化し得るのは当日と（境界近傍の）前日のみ。確定日は recompute 側で保護。
  const result = recompute(db, { onlyDays: [today, yesterday] });

  // 当日と前日を評価（latch 更新）。false→true になったら自動 reveal を発火。
  for (const day of [yesterday, today]) {
    const evalResult = evaluateDay(db, day, nowMs);
    if (evalResult.justUnlocked) {
      // 自動 reveal は非同期（子プロセス）。失敗はログのみで pipeline は止めない。
      void maybeAutoReveal(db, day, nowMs).catch(() => {
        /* reveal 失敗は revealed_password_log に記録済み */
      });
    }
  }

  const changedDays = [...new Set(result.dailyTotals.map((t) => t.dayKey))];
  return { today, changedDays };
}
