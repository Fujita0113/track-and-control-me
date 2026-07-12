import { Cron } from 'croner';
import type { DB } from '../db/index.js';
import { getConfig } from '../db/index.js';
import { dayKeyFor, prevDayKey } from '../aggregation/index.js';
import { markPast, ensureFrozenIfDue } from '../rules/rules.js';
import { runPipeline } from './pipeline.js';

/**
 * 日次ロールオーバー（design.md D7 / task 7.1）。
 * day_boundary(04:00) に前日を不変スナップショット化し is_final を刻む。
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
    // 過去に残った DRAFT（初期ブートストラップの当日ルール・当日追加の DRAFT_TODAY 等）を
    // 凍結してから PAST 化する。同日中は編集可としていた当日ルールも、翌日以降はここで確実に凍結される。
    db.prepare(
      "UPDATE daily_rule_set SET status = 'FROZEN_ACTIVE', frozen_at = ? WHERE status IN ('DRAFT_FUTURE', 'DRAFT_TODAY') AND effective_date < ?",
    ).run(nowMs, today);
    // 当日ルールを凍結、それ以前の凍結ルールを PAST へ。
    ensureFrozenIfDue(db, today, nowMs);
    markPast(db, today);
  });
  tx();

  log?.(`rollover: ${yesterday} を確定・${today} を凍結`);
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
