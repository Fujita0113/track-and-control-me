import { createHash } from 'node:crypto';
import type { DB } from '../db/index.js';
import { getConfig } from '../db/index.js';
import { dayKeyFor, nextDayKey } from '../aggregation/index.js';
import { recordCategoryUse } from '../services/manual-categories.js';

/**
 * 日次ルールセットの CRUD と凍結（design.md D7 / spec: work-rules-engine）。
 * 当日・過去は凍結（編集不可）、未来のみ編集可。凍結は app 層＋DBトリガの二重。
 */

export type RuleTarget = 'GROUP' | 'TOTAL_WORK' | 'MANUAL_CHECK' | 'PLANNING' | 'TIMELINE';
// DRAFT_TODAY: 当日のみ可変（当日追加を表す）。freeze-on-read で当日は凍結せず、
// 日境界の rollover で FROZEN_ACTIVE → PAST へ確定する（spec: same-day-rule-additions / design.md D1）。
export type RuleStatus = 'DRAFT_FUTURE' | 'DRAFT_TODAY' | 'FROZEN_ACTIVE' | 'PAST';

/**
 * 当日追加（DRAFT_TODAY）の条件は sort_order にこの下駄を履かせて格納し、
 * baseline（day 開始時点の凍結条件・sort_order < SAME_DAY_BASE）と区別する。
 * これにより新テーブル・スキーマ変更なしで「baseline は不変・追加分のみ可変」を安定して表現する。
 */
export const SAME_DAY_BASE = 100_000;

export class FrozenRuleError extends Error {
  constructor(dayKey: string) {
    super(`当日/過去のルールは凍結されています: ${dayKey}`);
    this.name = 'FrozenRuleError';
  }
}

/**
 * 当日編集が day 開始時点の baseline ゲートを緩めるとき投げる（spec: same-day-rule-additions D2）。
 * 既存の凍結条件の削除・値変更・combinator 緩和が対象。API は 400（baseline 違反）で返す。
 * FrozenRuleError の派生にして「当日は緩められない」という凍結ポリシーの一種として扱う
 * （既存の `toThrow(FrozenRuleError)` 系の回帰も保つ。API は BaselineViolationError を先に判定する）。
 */
export class BaselineViolationError extends FrozenRuleError {
  constructor(dayKey: string, detail: string) {
    super(dayKey);
    this.name = 'BaselineViolationError';
    this.message = `当日の編集では day 開始時点のゲートを緩められません（${detail}）: ${dayKey}`;
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
    case 'TIMELINE':
      // ラベル（カテゴリ名）を安定キーに用いる（GROUP が stable_group_id で一致するのと対称）。
      // 並び順に依存しないため manual:<index> の弱同一性を解消する。
      return `timeline:${c.label ?? 'uncategorized'}`;
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
 * ジャンル固定の適用後検証（design.md D2 / spec: goal-challenge・same-day-rule-additions）。
 * アクティブ（進行中/開始前）な各目標について、残期間（max(今日, start_day)〜end_day）の各日の
 * 実効ルールを解決し、全採用実践 condition_key の存在を確認する。欠けていれば GoalLockError。
 * ロック起点を「今日」に据えることで、今日開始の目標が当日採用した条件（当日追加を含む）を
 * 同日から保護する（当日の削除・骨抜きを拒否）。持ち越し・削除フォールバックも「解決して確認」で一括カバー。
 * 目標が無い環境では goal テーブルが空なので完全な no-op（既存挙動を変えない）。
 */
function assertGoalsSatisfied(db: DB, nowMs: number): void {
  const today = todayKey(db, nowMs);
  const goals = db
    .prepare('SELECT id, name, start_day, end_day FROM goal WHERE end_day >= ?')
    .all(today) as GoalLockRow[];
  for (const g of goals) {
    const keys = (
      db.prepare('SELECT condition_key FROM goal_practice WHERE goal_id = ?').all(g.id) as {
        condition_key: string;
      }[]
    ).map((r) => r.condition_key);
    if (keys.length === 0) continue;
    const from = g.start_day > today ? g.start_day : today; // max(今日, start_day)
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

/** effectiveDate の実効ルールにおける時間条件（TOTAL_WORK/GROUP/TIMELINE）の condition_key → 閾値秒。 */
export function effectiveTimeThresholds(db: DB, effectiveDate: string, nowMs: number): Map<string, number | null> {
  const eff = getEffectiveRuleSet(db, effectiveDate, nowMs);
  const map = new Map<string, number | null>();
  for (const c of eff?.conditions ?? []) {
    if (c.target === 'TOTAL_WORK' || c.target === 'GROUP' || c.target === 'TIMELINE')
      map.set(c.condition_key, c.threshold_seconds);
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
  const adopted = new Set(
    (
      db
        .prepare(
          `SELECT DISTINCT gp.condition_key AS key
           FROM goal_practice gp JOIN goal g ON g.id = gp.goal_id
           WHERE gp.target IN ('TOTAL_WORK', 'GROUP', 'TIMELINE')
             AND g.end_day >= ? AND g.start_day <= ? AND g.end_day >= ?`,
        )
        .all(today, effectiveDate, effectiveDate) as { key: string }[]
    ).map((r) => r.key),
  );
  if (adopted.size === 0) return;

  const afterThresholds = new Map<string, number | null>();
  input.conditions.forEach((c, i) => {
    if (c.target === 'TOTAL_WORK' || c.target === 'GROUP' || c.target === 'TIMELINE')
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

/** day 開始時点の baseline ゲート（当日追加の下敷き・spec: same-day-rule-additions D2）。 */
interface TodayBaseline {
  conditions: RuleConditionRow[];
  combinator: string;
}

/**
 * 当日（today）の day 開始時点の実効条件（baseline）を解決する。
 * - 当日ルールが DRAFT_TODAY: 当日追加分（sort_order >= SAME_DAY_BASE）を除いた条件が baseline。
 * - 当日ルールがそれ以外で存在（FROZEN_ACTIVE 等）: その全条件が baseline。
 * - 当日ルールが無い: 直近の過去ルール（effective_date < today）から継承した条件が baseline。
 * - いずれも無い（真の初期状態）: null（守るべき baseline が無い＝ブートストラップ）。
 */
function resolveTodayBaseline(db: DB, today: string): TodayBaseline | null {
  const todayRow = getRuleSet(db, today);
  if (todayRow) {
    const conds =
      todayRow.ruleSet.status === 'DRAFT_TODAY'
        ? todayRow.conditions.filter((c) => c.sort_order < SAME_DAY_BASE)
        : todayRow.conditions;
    return { conditions: conds, combinator: todayRow.ruleSet.combinator };
  }
  const prior = db
    .prepare('SELECT * FROM daily_rule_set WHERE effective_date < ? ORDER BY effective_date DESC LIMIT 1')
    .get(today) as RuleSetRow | undefined;
  if (!prior) return null;
  const conds = db
    .prepare('SELECT * FROM rule_condition WHERE rule_set_id = ? ORDER BY sort_order, id')
    .all(prior.id) as RuleConditionRow[];
  return { conditions: conds, combinator: prior.combinator };
}

/** baseline 条件と入力条件の属性が一致するか（既存凍結条件が当日いじられていないかの判定）。 */
function sameConditionAttrs(bc: RuleConditionRow, c: ConditionInput): boolean {
  return (
    bc.target === c.target &&
    (bc.comparator || 'GTE') === (c.comparator ?? 'GTE') &&
    (bc.threshold_seconds ?? null) === (c.thresholdSeconds ?? null) &&
    (bc.label ?? null) === (c.label ?? null) &&
    (bc.signal_key ?? null) === (c.signalKey ?? null) &&
    (bc.stable_group_id ?? null) === (c.stableGroupId ?? null)
  );
}

/**
 * 当日（DRAFT_TODAY）への add-only 書き込み（spec: same-day-rule-additions D1/D2）。
 * baseline（day 開始時点の実効条件）を完全に保存し、新規 condition_key の追加のみ許す。
 * baseline の欠落・値変更・combinator 緩和は BaselineViolationError で拒否（トランザクション ABORT）。
 * 当日ルールが無ければ baseline を materialize、既存 FROZEN_ACTIVE 当日行なら DRAFT_TODAY へ開き直す。
 * baseline は sort_order < SAME_DAY_BASE、追加分は >= SAME_DAY_BASE で格納し安定して区別する。
 */
function upsertTodayRuleSet(
  db: DB,
  today: string,
  input: { combinator?: 'ALL'; conditions: ConditionInput[] },
  nowMs: number,
  opts: { thresholdChangeReason?: string | null },
): RuleSetWithConditions {
  const baseline = resolveTodayBaseline(db, today);
  // canWriteTodayRule=false でここに来る以上、baseline は存在する（ブートストラップは full-edit 経路）。
  if (!baseline) throw new FrozenRuleError(today);

  // 入力条件へ condition_key を割り当て（未指定は target から導出）。
  const inputKeyed = input.conditions.map((c, i) => ({ c, key: deriveConditionKey(c, i) }));
  const inputByKey = new Map(inputKeyed.map((x) => [x.key, x]));

  // combinator は当日変更不可（AND→OR 等の骨抜き防止）。baseline に条件があれば一致を要求。
  const combinator = input.combinator ?? (baseline.combinator as 'ALL');
  if (baseline.conditions.length > 0 && combinator !== baseline.combinator) {
    throw new BaselineViolationError(today, 'combinator を変更できません');
  }

  // baseline の各条件は結果セットに同一属性で存在しなければならない（欠落・値変更は拒否）。
  for (const bc of baseline.conditions) {
    const found = inputByKey.get(bc.condition_key);
    if (!found) throw new BaselineViolationError(today, `既存条件「${bc.condition_key}」を外せません`);
    if (!sameConditionAttrs(bc, found.c))
      throw new BaselineViolationError(today, `既存条件「${bc.condition_key}」の値は当日変更できません`);
  }

  // 差分＝baseline に無い新規 condition_key のみ許可（当日追加分）。
  const baselineKeys = new Set(baseline.conditions.map((c) => c.condition_key));
  const additions = inputKeyed.filter((x) => !baselineKeys.has(x.key));

  const beforeThresholds = effectiveTimeThresholds(db, today, nowMs);
  const now = nowMs;
  const hash = contentHash(combinator, [
    ...baseline.conditions.map((bc) => ({
      target: bc.target,
      stableGroupId: bc.stable_group_id,
      comparator: (bc.comparator as 'GTE') || 'GTE',
      thresholdSeconds: bc.threshold_seconds,
      label: bc.label,
      signalKey: bc.signal_key,
    })),
    ...additions.map((x) => x.c),
  ]);

  const insCond = db.prepare(
    `INSERT INTO rule_condition
       (rule_set_id, target, stable_group_id, comparator, threshold_seconds, label, signal_key, condition_key, sort_order)
     VALUES (@set, @target, @group, @comparator, @threshold, @label, @signal, @key, @sort)`,
  );

  const tx = db.transaction(() => {
    let rs = db
      .prepare('SELECT * FROM daily_rule_set WHERE effective_date = ?')
      .get(today) as RuleSetRow | undefined;
    if (!rs) {
      // materialize: baseline を effective_date=today の DRAFT_TODAY 行へ複製する。
      const info = db
        .prepare(
          `INSERT INTO daily_rule_set (effective_date, combinator, status, content_hash, created_at, updated_at)
           VALUES (?, ?, 'DRAFT_TODAY', ?, ?, ?)`,
        )
        .run(today, combinator, hash, now, now);
      rs = db.prepare('SELECT * FROM daily_rule_set WHERE id = ?').get(info.lastInsertRowid as number) as RuleSetRow;
      baseline.conditions.forEach((bc, i) =>
        insCond.run({
          set: rs!.id,
          target: bc.target,
          group: bc.stable_group_id,
          comparator: bc.comparator || 'GTE',
          threshold: bc.threshold_seconds,
          label: bc.label,
          signal: bc.signal_key,
          key: bc.condition_key,
          sort: i, // baseline は sort_order < SAME_DAY_BASE。
        }),
      );
    } else if (rs.status !== 'DRAFT_TODAY') {
      // reopen: 既存 FROZEN_ACTIVE 当日行を DRAFT_TODAY へ開き直す（status のみ UPDATE・combinator 不変）。
      db.prepare('UPDATE daily_rule_set SET status = ?, content_hash = ?, updated_at = ? WHERE id = ?').run(
        'DRAFT_TODAY',
        hash,
        now,
        rs.id,
      );
    } else {
      // 既に DRAFT_TODAY: 追加分だけ入れ替えるため content_hash を更新（combinator 不変）。
      db.prepare('UPDATE daily_rule_set SET content_hash = ?, updated_at = ? WHERE id = ?').run(hash, now, rs.id);
    }

    // 当日追加分（sort_order >= SAME_DAY_BASE）を全消し → 今回の追加を採番し直す。baseline 行は不変。
    db.prepare('DELETE FROM rule_condition WHERE rule_set_id = ? AND sort_order >= ?').run(rs.id, SAME_DAY_BASE);
    additions.forEach((x, j) => {
      insCond.run({
        set: rs!.id,
        target: x.c.target,
        group: x.c.stableGroupId ?? null,
        comparator: x.c.comparator ?? 'GTE',
        threshold: x.c.thresholdSeconds ?? null,
        label: x.c.label ?? null,
        signal: x.c.signalKey ?? null,
        key: x.key,
        sort: SAME_DAY_BASE + j,
      });
      if (x.c.target === 'TIMELINE' && (x.c.label ?? '').trim()) recordCategoryUse(db, x.c.label!, now);
    });

    // 適用後にジャンル固定を検証し、採用中条件の閾値変更を理由つきで記録する（当日採用のロックインを含む）。
    assertGoalsSatisfied(db, nowMs);
    recordThresholdChanges(db, today, beforeThresholds, { conditions: input.conditions }, opts.thresholdChangeReason, nowMs);
  });
  tx();
  return getRuleSet(db, today)!;
}

/**
 * 未来日のルールセットを作成/全置換する。過去は FrozenRuleError。
 * 当日は、実効ルールが皆無のブートストラップ時のみ全編集可。baseline がある当日は
 * add-only 経路（`upsertTodayRuleSet`）へ委譲し、baseline を緩める編集は BaselineViolationError。
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
  // 過去は常に凍結。
  if (effectiveDate < today) throw new FrozenRuleError(effectiveDate);
  // 当日で baseline がある（ブートストラップでない）場合は当日 add-only 経路へ。
  if (effectiveDate === today && !canWriteTodayRule(db, today)) {
    return upsertTodayRuleSet(db, today, input, nowMs, opts);
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
      // TIMELINE 条件のカテゴリラベルは手動カテゴリレジストリへ upsert する（記録経路と同じ扱い）。
      // 未登録名の入力でも以後の候補に並び、一致キーとして安定する。
      if (c.target === 'TIMELINE' && (c.label ?? '').trim()) recordCategoryUse(db, c.label!, now);
    });
    // 適用後にジャンル固定を検証し、採用中条件の閾値変更を理由つきで記録する。
    assertGoalsSatisfied(db, nowMs);
    recordThresholdChanges(db, effectiveDate, beforeThresholds, input, opts.thresholdChangeReason, nowMs);
  });
  tx();
  return getRuleSet(db, effectiveDate)!;
}

/**
 * ルールセットを削除する。過去は FrozenRuleError。
 * 当日は、ブートストラップ（当日作成・未凍結）なら全削除、DRAFT_TODAY（当日追加あり）なら
 * 当日追加分だけを撤回して baseline（追加前）へ戻す。FROZEN_ACTIVE・継承の当日は削除不可。
 * 採用中実践が消えるなら GoalLockError（当日採用した追加条件の当日削除も拒否）。
 */
export function deleteRuleSet(db: DB, effectiveDate: string, nowMs = Date.now()): boolean {
  const today = todayKey(db, nowMs);
  // 過去は常に凍結。
  if (effectiveDate < today) throw new FrozenRuleError(effectiveDate);
  if (effectiveDate === today && !canWriteTodayRule(db, today)) {
    // 当日追加あり（DRAFT_TODAY）なら追加分だけ撤回。それ以外（FROZEN_ACTIVE・継承）は削除不可。
    const todayRow = getRuleSet(db, today);
    if (!todayRow || todayRow.ruleSet.status !== 'DRAFT_TODAY') throw new FrozenRuleError(effectiveDate);
    return retractTodayAdditions(db, today, todayRow, nowMs);
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
 * 当日追加分（DRAFT_TODAY の sort_order >= SAME_DAY_BASE）を撤回し baseline へ戻す（spec D2/2.6）。
 * - materialize 由来（当日作成の行）: 行ごと削除して継承 baseline へ戻す。
 * - reopen 由来（前日以前に作成の行）: 追加分だけ削除し FROZEN_ACTIVE へ戻す（baseline 行は不変）。
 * 採用中の当日追加条件は assertGoalsSatisfied が GoalLockError で保護する（同日でも撤回不可）。
 */
function retractTodayAdditions(db: DB, today: string, todayRow: RuleSetWithConditions, nowMs: number): boolean {
  const createdToday = ruleCreatedDay(db, todayRow.ruleSet.created_at) === today;
  const tx = db.transaction(() => {
    if (createdToday) {
      db.prepare('DELETE FROM rule_condition WHERE rule_set_id = ?').run(todayRow.ruleSet.id);
      db.prepare('DELETE FROM daily_rule_set WHERE id = ?').run(todayRow.ruleSet.id);
    } else {
      db.prepare('DELETE FROM rule_condition WHERE rule_set_id = ? AND sort_order >= ?').run(
        todayRow.ruleSet.id,
        SAME_DAY_BASE,
      );
      db.prepare("UPDATE daily_rule_set SET status = 'FROZEN_ACTIVE', frozen_at = ?, updated_at = ? WHERE id = ?").run(
        nowMs,
        nowMs,
        todayRow.ruleSet.id,
      );
    }
    // 採用中の当日追加条件が消えるなら ABORT（当日でも骨抜き不可）。
    assertGoalsSatisfied(db, nowMs);
    return true;
  });
  return tx();
}

/**
 * dayKey のルールセットが凍結対象かつ未凍結なら FROZEN_ACTIVE を刻む（freeze-on-read）。
 * DRAFT_FUTURE / DRAFT_TODAY を対象にする。ただし当日（effective_date == today）の
 * DRAFT_TODAY（当日追加）と、当日作成のブートストラップ DRAFT_FUTURE は当日のうちは凍結しない。
 * effective_date < today の DRAFT_TODAY は通常どおり FROZEN_ACTIVE へ確定する（rollover 担保）。
 */
export function ensureFrozenIfDue(db: DB, dayKey: string, nowMs = Date.now()): void {
  const today = todayKey(db, nowMs);
  if (dayKey > today) return; // 未来はそのまま
  const rs = db
    .prepare("SELECT * FROM daily_rule_set WHERE effective_date = ? AND status IN ('DRAFT_FUTURE', 'DRAFT_TODAY')")
    .get(dayKey) as RuleSetRow | undefined;
  if (!rs) return;
  if (dayKey === today) {
    // 当日追加（DRAFT_TODAY）は当日のうちは可変のまま。
    if (rs.status === 'DRAFT_TODAY') return;
    // 当日に作成された当日ルール（初期ブートストラップ）も、その日のうちは凍結しない。
    if (ruleCreatedDay(db, rs.created_at) === today) return;
  }
  db.prepare(
    "UPDATE daily_rule_set SET status = 'FROZEN_ACTIVE', frozen_at = ? WHERE id = ? AND status IN ('DRAFT_FUTURE', 'DRAFT_TODAY')",
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
