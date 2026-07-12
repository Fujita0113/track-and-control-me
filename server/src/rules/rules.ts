import { createHash } from 'node:crypto';
import type { DB } from '../db/index.js';
import { getConfig } from '../db/index.js';
import { dayKeyFor, nextDayKey } from '../aggregation/index.js';

/**
 * 日次ルールセットの CRUD と凍結（design.md D7 / spec: work-rules-engine）。
 * 当日・過去は凍結（編集不可）、未来のみ編集可。凍結は app 層＋DBトリガの二重。
 */

export type RuleTarget = 'GROUP' | 'TOTAL_WORK' | 'MANUAL_CHECK' | 'PLANNING';
export type RuleStatus = 'DRAFT_FUTURE' | 'FROZEN_ACTIVE' | 'PAST';

export class FrozenRuleError extends Error {
  constructor(dayKey: string) {
    super(`当日/過去のルールは凍結されています: ${dayKey}`);
    this.name = 'FrozenRuleError';
  }
}

/**
 * ジャンル固定（spec: goal-challenge / design.md D2）。編集の結果、アクティブな目標の残期間の
 * いずれかの日で採用実践の condition_key が実効ルールから欠ける場合に投げる（トランザクション ABORT）。
 */
export class GoalLockError extends Error {
  constructor(goalName: string, conditionKey: string, dayKey: string) {
    super(`目標「${goalName}」が採用中の実践「${conditionKey}」が ${dayKey} の実効ルールから外れます（ジャンル固定）`);
    this.name = 'GoalLockError';
  }
}

/** 採用中条件の閾値変更に理由が伴わないとき投げる（API は 400・design.md D2）。 */
export class ThresholdReasonRequiredError extends Error {
  constructor(keys: string[]) {
    super(`採用中の実践（${keys.join(', ')}）の閾値変更には理由が必要です`);
    this.name = 'ThresholdReasonRequiredError';
  }
}

export interface RuleSetRow {
  id: number;
  effective_date: string;
  combinator: string;
  status: RuleStatus;
  frozen_at: number | null;
  content_hash: string | null;
  created_at: number;
  updated_at: number;
}

export interface RuleConditionRow {
  id: number;
  rule_set_id: number;
  target: RuleTarget;
  stable_group_id: string | null;
  comparator: string;
  threshold_seconds: number | null;
  label: string | null;
  signal_key: string | null;
  condition_key: string;
  sort_order: number;
}

export interface ConditionInput {
  target: RuleTarget;
  stableGroupId?: string | null;
  comparator?: 'GTE';
  thresholdSeconds?: number | null;
  label?: string | null;
  signalKey?: string | null;
  conditionKey?: string;
}

export interface RuleSetWithConditions {
  ruleSet: RuleSetRow;
  conditions: RuleConditionRow[];
}

export function todayKey(db: DB, nowMs = Date.now()): string {
  const cfg = getConfig(db);
  return dayKeyFor(nowMs, cfg.tz, cfg.day_boundary_minutes);
}

/** ルール作成時刻の day_key（当日作成=ブートストラップの判定に使う）。 */
function ruleCreatedDay(db: DB, createdAt: number): string {
  const cfg = getConfig(db);
  return dayKeyFor(createdAt, cfg.tz, cfg.day_boundary_minutes);
}

/**
 * 当日ルールを作成/編集できるか（初期ブートストラップ例外）。
 * 凍結ポリシーの目的は「既存の解錠条件を当日に骨抜きするゲーミング」の抑制。
 * 実効ルールが 1 つも無い真の初期状態では、抑制すべき既存条件が存在しないため、
 * その日に当日ルールを作成し、同日中は何度でも編集できる（タイポ/達成不能のやり直しを許容）。
 * 翌日以降は通常どおり凍結される（`ensureFrozenIfDue` / rollover が担保）。
 * - 既存の当日ルールが「当日作成・未凍結」なら編集可。
 * - 当日ルールが無い場合は、継承元も含め実効ルールが皆無のときだけ新規作成可。
 */
function canWriteTodayRule(db: DB, today: string): boolean {
  const existing = getRuleSet(db, today);
  if (existing) {
    return (
      existing.ruleSet.status === 'DRAFT_FUTURE' &&
      ruleCreatedDay(db, existing.ruleSet.created_at) === today
    );
  }
  const prior = db
    .prepare('SELECT 1 FROM daily_rule_set WHERE effective_date < ? LIMIT 1')
    .get(today) as unknown;
  return prior === undefined; // 継承元も無い＝真の初期状態のみ許可
}

function deriveConditionKey(c: ConditionInput, index: number): string {
  if (c.conditionKey) return c.conditionKey;
  switch (c.target) {
    case 'TOTAL_WORK':
      return 'total_work';
    case 'GROUP':
      return `group:${c.stableGroupId ?? 'unknown'}`;
    case 'MANUAL_CHECK':
      return `manual:${index}`;
    case 'PLANNING':
      return `planning:${c.signalKey ?? 'default'}`;
  }
}

function contentHash(combinator: string, conditions: ConditionInput[]): string {
  const canonical = JSON.stringify({
    combinator,
    conditions: conditions.map((c) => ({
      target: c.target,
      stableGroupId: c.stableGroupId ?? null,
      comparator: c.comparator ?? 'GTE',
      thresholdSeconds: c.thresholdSeconds ?? null,
      label: c.label ?? null,
      signalKey: c.signalKey ?? null,
    })),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export function getRuleSet(db: DB, dayKey: string): RuleSetWithConditions | null {
  const rs = db
    .prepare('SELECT * FROM daily_rule_set WHERE effective_date = ?')
    .get(dayKey) as RuleSetRow | undefined;
  if (!rs) return null;
  const conditions = db
    .prepare('SELECT * FROM rule_condition WHERE rule_set_id = ? ORDER BY sort_order, id')
    .all(rs.id) as RuleConditionRow[];
  return { ruleSet: rs, conditions };
}

export function listRuleSets(db: DB): RuleSetWithConditions[] {
  const rows = db
    .prepare('SELECT * FROM daily_rule_set ORDER BY effective_date DESC')
    .all() as RuleSetRow[];
  return rows.map((rs) => ({
    ruleSet: rs,
    conditions: db
      .prepare('SELECT * FROM rule_condition WHERE rule_set_id = ? ORDER BY sort_order, id')
      .all(rs.id) as RuleConditionRow[],
  }));
}

interface GoalLockRow {
  id: number;
  name: string;
  start_day: string;
  end_day: string;
}

/**
 * ジャンル固定の適用後検証（design.md D2）。アクティブ（進行中/開始前）な各目標について、
 * 残期間（max(明日, start_day)〜end_day）の各日の実効ルールを解決し、全採用実践 condition_key の
 * 存在を確認する。欠けていれば GoalLockError。持ち越し・削除フォールバックも「解決して確認」で一括カバー。
 * 目標が無い環境では goal テーブルが空なので完全な no-op（既存挙動を変えない）。
 */
function assertGoalsSatisfied(db: DB, nowMs: number): void {
  const today = todayKey(db, nowMs);
  const tomorrow = nextDayKey(today);
  const goals = db
    .prepare('SELECT id, name, start_day, end_day FROM goal WHERE end_day >= ?')
    .all(tomorrow) as GoalLockRow[];
  for (const g of goals) {
    const keys = (
      db.prepare('SELECT condition_key FROM goal_practice WHERE goal_id = ?').all(g.id) as {
        condition_key: string;
      }[]
    ).map((r) => r.condition_key);
    if (keys.length === 0) continue;
    const from = g.start_day > tomorrow ? g.start_day : tomorrow; // max(明日, start_day)
    let day = from;
    let guard = 0;
    while (day <= g.end_day && guard++ < 60) {
      const eff = getEffectiveRuleSet(db, day, nowMs);
      const present = new Set((eff?.conditions ?? []).map((c) => c.condition_key));
      for (const k of keys) if (!present.has(k)) throw new GoalLockError(g.name, k, day);
      day = nextDayKey(day);
    }
  }
}

/** effectiveDate の実効ルールにおける時間条件（TOTAL_WORK/GROUP）の condition_key → 閾値秒。 */
function effectiveTimeThresholds(db: DB, effectiveDate: string, nowMs: number): Map<string, number | null> {
  const eff = getEffectiveRuleSet(db, effectiveDate, nowMs);
  const map = new Map<string, number | null>();
  for (const c of eff?.conditions ?? []) {
    if (c.target === 'TOTAL_WORK' || c.target === 'GROUP') map.set(c.condition_key, c.threshold_seconds);
  }
  return map;
}

/**
 * 採用中の時間条件の閾値変更（上げ下げ問わず）を検出し、理由必須化＋記録する（design.md D2）。
 * effectiveDate に稼働中（完走前・当日が期間内）の目標が採用する時間条件で、変更前後の閾値が
 * 異なるものが対象。理由が無ければ ThresholdReasonRequiredError。記録は condition_key 単位で1本。
 */
function recordThresholdChanges(
  db: DB,
  effectiveDate: string,
  beforeThresholds: Map<string, number | null>,
  input: { conditions: ConditionInput[] },
  reason: string | null | undefined,
  nowMs: number,
): void {
  const today = todayKey(db, nowMs);
  const tomorrow = nextDayKey(today);
  const adopted = new Set(
    (
      db
        .prepare(
          `SELECT DISTINCT gp.condition_key AS key
           FROM goal_practice gp JOIN goal g ON g.id = gp.goal_id
           WHERE gp.target IN ('TOTAL_WORK', 'GROUP')
             AND g.end_day >= ? AND g.start_day <= ? AND g.end_day >= ?`,
        )
        .all(tomorrow, effectiveDate, effectiveDate) as { key: string }[]
    ).map((r) => r.key),
  );
  if (adopted.size === 0) return;

  const afterThresholds = new Map<string, number | null>();
  input.conditions.forEach((c, i) => {
    if (c.target === 'TOTAL_WORK' || c.target === 'GROUP')
      afterThresholds.set(deriveConditionKey(c, i), c.thresholdSeconds ?? null);
  });

  const changes: { key: string; before: number | null; after: number | null }[] = [];
  for (const key of adopted) {
    const before = beforeThresholds.get(key);
    const after = afterThresholds.get(key);
    // 「両方に存在し値が異なる」だけを変更として扱う（削除はジャンル固定が別途 ABORT）。
    if (before != null && after != null && before !== after) changes.push({ key, before, after });
  }
  if (changes.length === 0) return;

  const r = (reason ?? '').trim();
  if (!r) throw new ThresholdReasonRequiredError(changes.map((c) => c.key));
  const ins = db.prepare(
    `INSERT INTO practice_threshold_change (condition_key, effective_date, old_seconds, new_seconds, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const c of changes) ins.run(c.key, effectiveDate, c.before, c.after, r, nowMs);
}

/**
 * 未来日のルールセットを作成/全置換する。当日・過去は FrozenRuleError。
 * 目標が採用中の条件はジャンル固定（削除・対象変更で GoalLockError）。閾値変更は理由必須
 * （opts.thresholdChangeReason・無ければ ThresholdReasonRequiredError）で記録する。
 */
export function upsertFutureRuleSet(
  db: DB,
  effectiveDate: string,
  input: { combinator?: 'ALL'; conditions: ConditionInput[] },
  nowMs = Date.now(),
  opts: { thresholdChangeReason?: string | null } = {},
): RuleSetWithConditions {
  const today = todayKey(db, nowMs);
  // 過去は常に凍結。当日は初期ブートストラップ時のみ許可（それ以外は凍結）。
  if (effectiveDate < today) throw new FrozenRuleError(effectiveDate);
  if (effectiveDate === today && !canWriteTodayRule(db, today)) {
    throw new FrozenRuleError(effectiveDate);
  }

  const combinator = input.combinator ?? 'ALL';
  const hash = contentHash(combinator, input.conditions);
  // 論理時刻(nowMs)で記帳する。ブートストラップ判定(created_at の day_key)を
  // 評価時刻と一致させるため、実時計 Date.now() ではなく nowMs を用いる。
  const now = nowMs;
  // 閾値変更検出のため、編集を書き込む前の実効閾値を先に取る（読み取り専用）。
  const beforeThresholds = effectiveTimeThresholds(db, effectiveDate, nowMs);

  const tx = db.transaction(() => {
    let rs = db
      .prepare('SELECT * FROM daily_rule_set WHERE effective_date = ?')
      .get(effectiveDate) as RuleSetRow | undefined;
    if (!rs) {
      const info = db
        .prepare(
          `INSERT INTO daily_rule_set (effective_date, combinator, status, content_hash, created_at, updated_at)
           VALUES (?, ?, 'DRAFT_FUTURE', ?, ?, ?)`,
        )
        .run(effectiveDate, combinator, hash, now, now);
      rs = db
        .prepare('SELECT * FROM daily_rule_set WHERE id = ?')
        .get(info.lastInsertRowid as number) as RuleSetRow;
    } else {
      if (rs.status !== 'DRAFT_FUTURE') throw new FrozenRuleError(effectiveDate);
      db.prepare(
        'UPDATE daily_rule_set SET combinator = ?, content_hash = ?, updated_at = ? WHERE id = ?',
      ).run(combinator, hash, now, rs.id);
    }
    db.prepare('DELETE FROM rule_condition WHERE rule_set_id = ?').run(rs.id);
    const ins = db.prepare(
      `INSERT INTO rule_condition
        (rule_set_id, target, stable_group_id, comparator, threshold_seconds, label, signal_key, condition_key, sort_order)
       VALUES (@set, @target, @group, @comparator, @threshold, @label, @signal, @key, @sort)`,
    );
    input.conditions.forEach((c, i) => {
      ins.run({
        set: rs!.id,
        target: c.target,
        group: c.stableGroupId ?? null,
        comparator: c.comparator ?? 'GTE',
        threshold: c.thresholdSeconds ?? null,
        label: c.label ?? null,
        signal: c.signalKey ?? null,
        key: deriveConditionKey(c, i),
        sort: i,
      });
    });
    // 適用後にジャンル固定を検証し、採用中条件の閾値変更を理由つきで記録する。
    assertGoalsSatisfied(db, nowMs);
    recordThresholdChanges(db, effectiveDate, beforeThresholds, input, opts.thresholdChangeReason, nowMs);
  });
  tx();
  return getRuleSet(db, effectiveDate)!;
}

/** 未来日のルールセットを削除する。当日・過去は FrozenRuleError。採用中実践が消えるなら GoalLockError。 */
export function deleteRuleSet(db: DB, effectiveDate: string, nowMs = Date.now()): boolean {
  const today = todayKey(db, nowMs);
  // 過去は常に凍結。当日は初期ブートストラップ（当日作成・未凍結）のみ削除可。
  if (effectiveDate < today) throw new FrozenRuleError(effectiveDate);
  if (effectiveDate === today && !canWriteTodayRule(db, today)) {
    throw new FrozenRuleError(effectiveDate);
  }
  const tx = db.transaction(() => {
    const res = db.prepare('DELETE FROM daily_rule_set WHERE effective_date = ?').run(effectiveDate);
    // 削除の持ち越しフォールバックを解決し、採用中実践が全日残ることを確認（欠ければ ABORT）。
    assertGoalsSatisfied(db, nowMs);
    return res.changes > 0;
  });
  return tx();
}

/**
 * dayKey のルールセットが凍結対象（effective_date <= today）かつ未凍結なら
 * FROZEN_ACTIVE を刻む（freeze-on-read）。DB トリガは DRAFT_FUTURE の記帳を許可。
 */
export function ensureFrozenIfDue(db: DB, dayKey: string, nowMs = Date.now()): void {
  const today = todayKey(db, nowMs);
  if (dayKey > today) return; // 未来はそのまま
  const rs = db
    .prepare("SELECT * FROM daily_rule_set WHERE effective_date = ? AND status = 'DRAFT_FUTURE'")
    .get(dayKey) as RuleSetRow | undefined;
  if (!rs) return;
  // 当日に作成された当日ルール（初期ブートストラップ）は、その日のうちは凍結しない。
  // 翌日以降（dayKey < today）は通常どおり凍結される。
  if (dayKey === today && ruleCreatedDay(db, rs.created_at) === today) return;
  db.prepare(
    "UPDATE daily_rule_set SET status = 'FROZEN_ACTIVE', frozen_at = ? WHERE id = ? AND status = 'DRAFT_FUTURE'",
  ).run(nowMs, rs.id);
}

/**
 * dayKey に適用する実効ルールセット。明示が無ければ直近の過去ルールへフォールバック。
 * 何も無ければ null（undefined_day_policy に委ねる）。
 */
export function getEffectiveRuleSet(db: DB, dayKey: string, nowMs = Date.now()): RuleSetWithConditions | null {
  ensureFrozenIfDue(db, dayKey, nowMs);
  const explicit = getRuleSet(db, dayKey);
  if (explicit) return explicit;
  const prior = db
    .prepare('SELECT * FROM daily_rule_set WHERE effective_date < ? ORDER BY effective_date DESC LIMIT 1')
    .get(dayKey) as RuleSetRow | undefined;
  if (!prior) return null;
  return {
    ruleSet: prior,
    conditions: db
      .prepare('SELECT * FROM rule_condition WHERE rule_set_id = ? ORDER BY sort_order, id')
      .all(prior.id) as RuleConditionRow[],
  };
}

/** 当日/過去のルールセットを FROZEN→PAST に更新（rollover 用）。 */
export function markPast(db: DB, beforeDayKey: string): void {
  db.prepare(
    "UPDATE daily_rule_set SET status = 'PAST' WHERE effective_date < ? AND status = 'FROZEN_ACTIVE'",
  ).run(beforeDayKey);
}
