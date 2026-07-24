import type { DB } from '../db/index.js';
import { totalWorkSecondsForDay } from '../services/categories.js';
import { resolvePlanningSignal } from '../services/planning.js';
import { getCheck } from './checks.js';
import {
  listActiveRules,
  ruleConditionKey,
  ruleSchedule,
  isRuleMetOn,
  rangeDayNumber,
  rangeSpanDays,
  type RuleRow,
  type RuleTarget,
  type RuleSchedule,
} from '../services/rule-registry.js';
import { listAliases, resolveGroupDisplay } from '../services/group-identity.js';

/**
 * 当日集計に対するルール評価 & latch（design.md D3・D4 / spec: editable-rule-registry・goal-check-gate）。
 * 実効ルールは `rule` 行から `rule:<id>` 起点で解決する（凍結モデル・`daily_rule_set` は撤廃済み）。
 * すべての実効ルールは **AND** で合成する（「採用」ジャンル・combinator の概念は撤廃・D3）。
 * 一度 first_met_at が刻まれたら以後 UNLOCKED を維持（手動編集で総計が減っても relock しない）。
 *
 * PHOTO/QUESTION（旧 Check）はもう合成条件ではなく第一級ルールとして同じ経路で合流する
 * （`check:<checkId>` 名前空間は廃止・design D3・spec: goal-check-gate）。
 */

export type UnlockStatus = 'LOCKED' | 'UNLOCKED';

export interface ConditionResult {
  /** 安定キー。当日以降は常に `rule:<id>`（過去の凍結行のみ legacy 形式がありうる）。 */
  conditionKey: string;
  ruleId: number;
  target: RuleTarget;
  met: boolean;
  actualSeconds?: number;
  thresholdSeconds?: number | null;
  label?: string | null;
  stableGroupId?: string | null;
  /** GROUP のとき identity の現在名/色（要再設定ヒント込み・design.md D8）。UI が UUID を触らずに描画できる。 */
  groupName?: string | null;
  groupColor?: string | null;
  signalKey?: string | null;
  /** PHOTO/QUESTION のスケジュール（今日タブ・不足条件の表示に使う）。 */
  schedule?: RuleSchedule;
  /** 範囲ルールのとき「N日中の何日目か」（1始まり）。単発・永続は null。 */
  rangeDayNumber?: number | null;
  spanDays?: number | null;
  startDay?: string;
  endDay?: string | null;
  /** このルールを追う目標（紐づく最初の1件・design D6）。無ければグローバル扱い。 */
  goalId?: number;
  goalName?: string;
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

/** ルールに紐づく最初の目標（id 昇順・design D6）。無ければ undefined（グローバル扱い）。 */
function primaryGoalForRule(db: DB, ruleId: number): { id: number; name: string } | undefined {
  const row = db
    .prepare(
      `SELECT g.id AS id, g.name AS name FROM goal_rule gr JOIN goal g ON g.id = gr.goal_id
        WHERE gr.rule_id = ? ORDER BY g.id LIMIT 1`,
    )
    .get(ruleId) as { id: number; name: string } | undefined;
  return row;
}

function answerDayKeysFor(db: DB, ruleId: number): string[] {
  return (
    db.prepare('SELECT day_key FROM rule_answer WHERE rule_id = ?').all(ruleId) as { day_key: string }[]
  ).map((r) => r.day_key);
}

function evaluateRule(db: DB, rule: RuleRow, dayKey: string, totalWorkSeconds: number): ConditionResult {
  const conditionKey = ruleConditionKey(rule.id);
  const schedule = ruleSchedule(rule.start_day, rule.end_day);
  const goal = primaryGoalForRule(db, rule.id);
  const base: ConditionResult = {
    conditionKey,
    ruleId: rule.id,
    target: rule.target,
    met: false,
    label: rule.label,
    signalKey: rule.signal_key,
    schedule,
    startDay: rule.start_day,
    endDay: rule.end_day,
    goalId: goal?.id,
    goalName: goal?.name,
  };

  switch (rule.target) {
    case 'TOTAL_WORK':
      return {
        ...base,
        actualSeconds: totalWorkSeconds,
        thresholdSeconds: rule.threshold_seconds,
        met: totalWorkSeconds >= (rule.threshold_seconds ?? 0),
      };
    case 'GROUP': {
      const groupDisplay = resolveGroupDisplay(db, rule);
      let actualSeconds: number;
      if (rule.group_identity_id != null) {
        const aliases = listAliases(db, rule.group_identity_id);
        if (aliases.length === 0) {
          actualSeconds = 0;
        } else {
          const placeholders = aliases.map(() => '(?, ?)').join(', ');
          const params = aliases.flatMap((a) => [a.name, a.color ?? '']);
          const row = db
            .prepare(
              `SELECT COALESCE(SUM(credited_ms), 0) AS ms FROM session
               WHERE day_key = ? AND (tab_group_name_snapshot, COALESCE(group_color_snapshot, '')) IN (${placeholders})`,
            )
            .get(dayKey, ...params) as { ms: number };
          actualSeconds = Math.floor(row.ms / 1000);
        }
      } else {
        // 後方互換: identity 参照を持たない旧 group:<stableGroupId> 条件は従来経路のまま評価する
        // （過去の判定を変えない・spec: group-rule-identity）。
        const row = db
          .prepare(
            'SELECT COALESCE(SUM(ms), 0) AS ms FROM daily_totals_snapshot WHERE day_key = ? AND stable_group_id = ?',
          )
          .get(dayKey, rule.stable_group_id) as { ms: number };
        actualSeconds = Math.floor(row.ms / 1000);
      }
      return {
        ...base,
        actualSeconds,
        thresholdSeconds: rule.threshold_seconds,
        stableGroupId: rule.stable_group_id,
        groupName: groupDisplay.needsReset ? `${groupDisplay.name}（要再設定）` : groupDisplay.name,
        groupColor: groupDisplay.color,
        met: actualSeconds >= (rule.threshold_seconds ?? 0),
      };
    }
    case 'TIMELINE': {
      // 持ち分 = (end_at - start_at) / n（同時記録は n=構成数で按分、単独記録は n=1 で区間長そのまま）。
      const row = db
        .prepare(
          `SELECT COALESCE(SUM((end_at - start_at) * 1.0 / n), 0) AS ms
           FROM activity_log_entry
           WHERE day_key = ? AND entry_type = 'MANUAL' AND category_key = ?`,
        )
        .get(dayKey, rule.label) as { ms: number };
      const actualSeconds = Math.floor(row.ms / 1000);
      return {
        ...base,
        actualSeconds,
        thresholdSeconds: rule.threshold_seconds,
        met: actualSeconds >= (rule.threshold_seconds ?? 0),
      };
    }
    case 'MANUAL_CHECK':
      return { ...base, met: getCheck(db, dayKey, conditionKey) };
    case 'PLANNING':
      return { ...base, met: resolvePlanningSignal(db, dayKey, rule.signal_key) };
    case 'PHOTO':
    case 'QUESTION': {
      const answerDayKeys = answerDayKeysFor(db, rule.id);
      return {
        ...base,
        label: rule.target === 'PHOTO' ? rule.caption : rule.question_text,
        met: isRuleMetOn(rule.target, schedule, answerDayKeys, dayKey),
        rangeDayNumber: rangeDayNumber(rule.start_day, rule.end_day, dayKey),
        spanDays: rangeSpanDays(rule.start_day, rule.end_day),
      };
    }
  }
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

  const activeRules = listActiveRules(db, dayKey);
  const totalWorkSeconds = totalWorkSecondsForDay(db, dayKey);
  const perCondition = activeRules.map((rule) => evaluateRule(db, rule, dayKey, totalWorkSeconds));
  // 全ルール AND（採用・combinator の概念は撤廃・design D3）。実効ルールが皆無なら達成不能。
  const conditionsMet = perCondition.length > 0 && perCondition.every((p) => p.met);

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
    hasRuleSet: perCondition.length > 0,
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
