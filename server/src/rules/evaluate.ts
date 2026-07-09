import type { DB } from '../db/index.js';
import { totalWorkSecondsForDay } from '../services/categories.js';
import { getPlanningSignal } from '../services/planning.js';
import { getEffectiveRuleSet, type RuleTarget } from './rules.js';
import { getCheck } from './checks.js';

/**
 * 当日集計に対するルール評価 & latch（design.md D7 / task 4.5）。
 * combinator=ALL（AND）。一度 first_met_at が刻まれたら以後 UNLOCKED を維持
 * （手動編集で総計が減っても relock しない）。
 */

export type UnlockStatus = 'LOCKED' | 'UNLOCKED';

export interface ConditionResult {
  conditionKey: string;
  target: RuleTarget;
  met: boolean;
  actualSeconds?: number;
  thresholdSeconds?: number | null;
  label?: string | null;
  stableGroupId?: string | null;
}

export interface EvalResult {
  dayKey: string;
  status: UnlockStatus;
  conditionsMet: boolean; // 現時点の充足（latch とは別）
  perCondition: ConditionResult[];
  firstMetAt: number | null;
  revealFired: boolean;
  hasRuleSet: boolean;
  justUnlocked: boolean;
}

interface UnlockRow {
  day_key: string;
  status: UnlockStatus;
  conditions_met: number;
  per_condition_results: string;
  first_met_at: number | null;
  reveal_fired: number;
  is_final: number;
  updated_at: number;
}

export function evaluateDay(db: DB, dayKey: string, nowMs = Date.now()): EvalResult {
  const prev = db
    .prepare('SELECT * FROM unlock_evaluation WHERE day_key = ?')
    .get(dayKey) as UnlockRow | undefined;

  // 確定済みは再評価しない（スナップショットを尊重）。
  if (prev && prev.is_final === 1) {
    return {
      dayKey,
      status: prev.status,
      conditionsMet: prev.conditions_met === 1,
      perCondition: JSON.parse(prev.per_condition_results) as ConditionResult[],
      firstMetAt: prev.first_met_at,
      revealFired: prev.reveal_fired === 1,
      hasRuleSet: true,
      justUnlocked: false,
    };
  }

  const eff = getEffectiveRuleSet(db, dayKey, nowMs);
  const perCondition: ConditionResult[] = [];
  let conditionsMet: boolean;

  if (!eff || eff.conditions.length === 0) {
    // ルール未定義 → undefined_day_policy=LOCKED（達成不能）。
    conditionsMet = false;
  } else {
    const totalWorkSeconds = totalWorkSecondsForDay(db, dayKey);
    for (const c of eff.conditions) {
      let met = false;
      let actualSeconds: number | undefined;
      switch (c.target) {
        case 'TOTAL_WORK':
          actualSeconds = totalWorkSeconds;
          met = actualSeconds >= (c.threshold_seconds ?? 0);
          break;
        case 'GROUP': {
          const row = db
            .prepare(
              'SELECT COALESCE(SUM(ms), 0) AS ms FROM daily_totals_snapshot WHERE day_key = ? AND stable_group_id = ?',
            )
            .get(dayKey, c.stable_group_id) as { ms: number };
          actualSeconds = Math.floor(row.ms / 1000);
          met = actualSeconds >= (c.threshold_seconds ?? 0);
          break;
        }
        case 'MANUAL_CHECK':
          met = getCheck(db, dayKey, c.condition_key);
          break;
        case 'PLANNING':
          met = getPlanningSignal(db, dayKey).planningDone;
          break;
      }
      perCondition.push({
        conditionKey: c.condition_key,
        target: c.target,
        met,
        actualSeconds,
        thresholdSeconds: c.threshold_seconds,
        label: c.label,
        stableGroupId: c.stable_group_id,
      });
    }
    const combinator = eff.ruleSet.combinator;
    conditionsMet =
      combinator === 'ANY' ? perCondition.some((p) => p.met) : perCondition.every((p) => p.met);
  }

  // latch: first_met_at は一度刻まれたら保持。
  const priorFirstMet = prev?.first_met_at ?? null;
  let firstMetAt = priorFirstMet;
  let justUnlocked = false;
  if (firstMetAt === null && conditionsMet) {
    firstMetAt = nowMs;
    justUnlocked = true;
  }
  const status: UnlockStatus = firstMetAt !== null ? 'UNLOCKED' : 'LOCKED';
  const revealFired = prev?.reveal_fired === 1;

  db.prepare(
    `INSERT INTO unlock_evaluation
       (day_key, status, conditions_met, per_condition_results, first_met_at, reveal_fired, is_final, updated_at)
     VALUES (@day, @status, @met, @per, @first, @revealFired, 0, @now)
     ON CONFLICT(day_key) DO UPDATE SET
       status = excluded.status,
       conditions_met = excluded.conditions_met,
       per_condition_results = excluded.per_condition_results,
       first_met_at = excluded.first_met_at,
       updated_at = excluded.updated_at`,
  ).run({
    day: dayKey,
    status,
    met: conditionsMet ? 1 : 0,
    per: JSON.stringify(perCondition),
    first: firstMetAt,
    revealFired: revealFired ? 1 : 0,
    now: nowMs,
  });

  return {
    dayKey,
    status,
    conditionsMet,
    perCondition,
    firstMetAt,
    revealFired,
    hasRuleSet: !!eff && eff.conditions.length > 0,
    justUnlocked,
  };
}

/** reveal_fired フラグを立てる（自動 reveal は一度だけ）。 */
export function markRevealFired(db: DB, dayKey: string): void {
  db.prepare('UPDATE unlock_evaluation SET reveal_fired = 1 WHERE day_key = ?').run(dayKey);
}

/** 現在の評価行を読む（副作用なし）。 */
export function getEvaluation(db: DB, dayKey: string): EvalResult | null {
  const row = db
    .prepare('SELECT * FROM unlock_evaluation WHERE day_key = ?')
    .get(dayKey) as UnlockRow | undefined;
  if (!row) return null;
  return {
    dayKey,
    status: row.status,
    conditionsMet: row.conditions_met === 1,
    perCondition: JSON.parse(row.per_condition_results) as ConditionResult[],
    firstMetAt: row.first_met_at,
    revealFired: row.reveal_fired === 1,
    hasRuleSet: true,
    justUnlocked: false,
  };
}
