import { Cron } from 'croner';
import type { DB } from '../db/index.js';
import { getConfig } from '../db/index.js';
import { dayKeyFor, prevDayKey } from '../aggregation/index.js';
import { runPipeline } from './pipeline.js';

/**
 * 日次ロールオーバー（design.md D3 / task 4.4）。
 * day_boundary(04:00) に前日を不変スナップショットとして確定する（is_final=1）。
 * ルール（`rule` 行）は凍結モデルを持たない＝いつでも追加・変更・削除でき当日から効くため、
 * ここでは過去日の集計・評価を確定するだけでよい（旧 daily_rule_set の凍結・PAST 化は撤去済み）。
 */

export function runRollover(db: DB, nowMs = Date.now(), log?: (m: string) => void): void {
  const cfg = getConfig(db);
  const today = dayKeyFor(nowMs, cfg.tz, cfg.day_boundary_minutes);
  const yesterday = prevDayKey(today);

  // 最終の再計算＋評価（当日/前日）。
  runPipeline(db, nowMs);

  const tx = db.transaction(() => {
    // 前日を確定（不変スナップショット）。
    db.prepare('UPDATE daily_totals_snapshot SET is_final = 1 WHERE day_key = ?').run(yesterday);
    db.prepare('UPDATE daily_excluded_snapshot SET ms = ms WHERE day_key = ?').run(yesterday);
    db.prepare(
      "UPDATE unlock_evaluation SET is_final = 1 WHERE day_key = ?",
    ).run(yesterday);
  });
  tx();

  log?.(`rollover: ${yesterday} を確定`);
}

/** croner で毎日 day_boundary に runRollover を発火。stop 関数を返す。 */
export function startRollover(db: DB, log?: (m: string) => void): () => void {
  const cfg = getConfig(db);
  const h = Math.floor(cfg.day_boundary_minutes / 60);
  const m = cfg.day_boundary_minutes % 60;
  const pattern = `${m} ${h} * * *`;
  const job = new Cron(pattern, { timezone: cfg.tz }, () => {
    try {
      runRollover(db, Date.now(), log);
    } catch (err) {
      log?.(`rollover 失敗: ${(err as Error).message}`);
    }
  });
  log?.(`rollover 予約: 毎日 ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} (${cfg.tz})`);
  return () => job.stop();
}
