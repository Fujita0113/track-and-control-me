import type { DB } from '../db/index.js';
import { todayKey } from './summary.js';
import { dayDiff } from './day-key.js';

/**
 * 解錠ルールの第一級レジストリ（spec: editable-rule-registry / design.md D1・D3・D4）。
 *
 * ルールは `rule` 行そのものが安定キー（`condition_key = 'rule:<id>'`）。中身（target・閾値・
 * グループ identity・ラベル・キャプション・質問文・スケジュール）が変わっても id は不変。
 * 凍結モデル（`RuleStatus`・freeze-on-read・baseline 検証・ジャンル固定）は撤廃済みで、
 * ルールはいつでも追加・変更・削除でき、当日の評価から反映される（過去日は凍結済みで不変）。
 * 全操作は非空の理由を要求し、`rule_change` に1操作1行で記録する（＝沿革の実体）。
 */

export type RuleTarget = 'TOTAL_WORK' | 'GROUP' | 'TIMELINE' | 'MANUAL_CHECK' | 'PLANNING' | 'PHOTO' | 'QUESTION';
export type RuleStatus = 'active' | 'removed';
export type RuleOp = 'add' | 'update' | 'remove';
/** スケジュール（軸2・種類とは独立）。`end_day=null` は永続、`start=end` は単発、`start<end` は範囲。 */
export type RuleSchedule = 'permanent' | 'single' | 'range';

export class RuleNotFoundError extends Error {
  constructor(id: number) {
    super(`ルールが見つかりません: ${id}`);
    this.name = 'RuleNotFoundError';
  }
}
export class ReasonRequiredError extends Error {
  constructor() {
    super('理由を入力してください');
    this.name = 'ReasonRequiredError';
  }
}
/** target 別の入力検証違反（例: ラベル空・閾値0以下・グループ未選択）。API は 400。 */
export class RuleValidationError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'RuleValidationError';
  }
}
/** 作成後は変更できない項目（写真ルールの先指定キャプション）への変更。API は 409。 */
export class RuleImmutableFieldError extends Error {
  constructor() {
    super('写真ルールのキャプションは作成後に変更できません');
    this.name = 'RuleImmutableFieldError';
  }
}

export interface RuleRow {
  id: number;
  target: RuleTarget;
  comparator: string;
  threshold_seconds: number | null;
  label: string | null;
  signal_key: string | null;
  stable_group_id: string | null;
  group_identity_id: number | null;
  caption: string | null;
  question_text: string | null;
  start_day: string;
  end_day: string | null;
  status: RuleStatus;
  legacy_condition_key: string | null;
  created_at: number;
}

/** ルールの「中身」（安定キー・寿命に無関係な、比較・保存対象のフィールド一式）。 */
export interface RuleContentInput {
  target: RuleTarget;
  comparator?: 'GTE';
  thresholdSeconds?: number | null;
  label?: string | null;
  signalKey?: string | null;
  groupIdentityId?: number | null;
  /** @deprecated 新規作成では使わない。壊れた旧参照の据え置き・移行専用。 */
  stableGroupId?: string | null;
  caption?: string | null;
  questionText?: string | null;
  /** スケジュール（軸2）。`endDay=null` は永続、`startDay===endDay` は単発。 */
  startDay: string;
  endDay?: string | null;
}

export interface CreateRuleInput extends RuleContentInput {
  reason: string;
}
export interface UpdateRuleInput extends RuleContentInput {
  reason: string;
}

function ruleConditionKey(ruleId: number): string {
  return `rule:${ruleId}`;
}
export { ruleConditionKey };

/** target 別の入力検証（spec: editable-rule-registry / goal-inline-condition）。 */
function validateContent(content: RuleContentInput): void {
  const t = content.target;
  if (!['TOTAL_WORK', 'GROUP', 'TIMELINE', 'MANUAL_CHECK', 'PLANNING', 'PHOTO', 'QUESTION'].includes(t))
    throw new RuleValidationError('ルール種別が不正です');
  if (t === 'TOTAL_WORK' || t === 'GROUP' || t === 'TIMELINE') {
    if (!(typeof content.thresholdSeconds === 'number' && content.thresholdSeconds > 0))
      throw new RuleValidationError('時間（分）は1分以上で指定してください');
  }
  if (t === 'GROUP' && content.groupIdentityId == null && !content.stableGroupId)
    throw new RuleValidationError('グループを選択してください');
  if (t === 'TIMELINE' && !(content.label ?? '').trim())
    throw new RuleValidationError('カテゴリ名を入力してください');
  if (t === 'MANUAL_CHECK' && !(content.label ?? '').trim())
    throw new RuleValidationError('チェック名を入力してください');
  if (t === 'PLANNING' && !(content.signalKey ?? '').trim())
    throw new RuleValidationError('翌日計画のシグナルを選択してください');
  if (t === 'PHOTO' && !(content.caption ?? '').trim())
    throw new RuleValidationError('撮るもの（キャプション）を入力してください');
  if (t === 'QUESTION' && !(content.questionText ?? '').trim())
    throw new RuleValidationError('質問文を入力してください');
  if (!content.startDay) throw new RuleValidationError('開始日を指定してください');
  if (content.endDay != null && content.endDay < content.startDay)
    throw new RuleValidationError('終了日は開始日以降にしてください');
}

function requireReason(reason: string | undefined | null): string {
  const r = (reason ?? '').trim();
  if (!r) throw new ReasonRequiredError();
  return r;
}

/** DB 行 → 中身スナップショット（`rule_change.before`/`after` に JSON で保存する単位）。 */
function contentSnapshot(row: {
  target: string;
  comparator: string;
  threshold_seconds: number | null;
  label: string | null;
  signal_key: string | null;
  stable_group_id: string | null;
  group_identity_id: number | null;
  caption: string | null;
  question_text: string | null;
  start_day: string;
  end_day: string | null;
}): Record<string, unknown> {
  return {
    target: row.target,
    comparator: row.comparator,
    thresholdSeconds: row.threshold_seconds,
    label: row.label,
    signalKey: row.signal_key,
    stableGroupId: row.stable_group_id,
    groupIdentityId: row.group_identity_id,
    caption: row.caption,
    questionText: row.question_text,
    startDay: row.start_day,
    endDay: row.end_day,
  };
}

function recordChange(
  db: DB,
  ruleId: number,
  op: RuleOp,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  reason: string,
  dayKey: string,
  nowMs: number,
): void {
  db.prepare(
    `INSERT INTO rule_change (rule_id, day_key, op, before, after, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(ruleId, dayKey, op, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, reason, nowMs);
}

export function getRule(db: DB, id: number): RuleRow {
  const row = db.prepare('SELECT * FROM rule WHERE id = ?').get(id) as RuleRow | undefined;
  if (!row) throw new RuleNotFoundError(id);
  return row;
}

export function findRule(db: DB, id: number): RuleRow | undefined {
  return db.prepare('SELECT * FROM rule WHERE id = ?').get(id) as RuleRow | undefined;
}

/**
 * ルールを新規作成する（reason 必須・design D4）。作成直後から `condition_key='rule:<id>'` で
 * 安定する。`rule_change`（op='add'・before=NULL）を同一トランザクションで記録する。
 */
export function createRule(db: DB, input: CreateRuleInput, nowMs = Date.now()): RuleRow {
  validateContent(input);
  const reason = requireReason(input.reason);
  const today = todayKey(db, nowMs);

  const tx = db.transaction((): RuleRow => {
    const info = db
      .prepare(
        `INSERT INTO rule
           (target, comparator, threshold_seconds, label, signal_key, stable_group_id, group_identity_id,
            caption, question_text, start_day, end_day, status, legacy_condition_key, created_at)
         VALUES (@target, @comparator, @threshold, @label, @signal, @group, @groupIdentityId,
                 @caption, @question, @startDay, @endDay, 'active', NULL, @now)`,
      )
      .run({
        target: input.target,
        comparator: input.comparator ?? 'GTE',
        threshold: input.thresholdSeconds ?? null,
        label: (input.label ?? '').toString().trim() || null,
        signal: input.signalKey ?? null,
        group: input.stableGroupId ?? null,
        groupIdentityId: input.groupIdentityId ?? null,
        caption: input.target === 'PHOTO' ? (input.caption ?? '').toString().trim() : null,
        question: input.target === 'QUESTION' ? (input.questionText ?? '').toString().trim() : null,
        startDay: input.startDay,
        endDay: input.endDay ?? null,
        now: nowMs,
      });
    const ruleId = info.lastInsertRowid as number;
    const row = getRule(db, ruleId);
    recordChange(db, ruleId, 'add', null, contentSnapshot(row), reason, today, nowMs);
    return row;
  });
  return tx();
}

/**
 * ルールの中身を編集する（reason 必須・design D1・D4）。フォーム全体を再送する想定
 * （作成と同じ形の入力）。写真ルールのキャプションは作成後変更できない（RuleImmutableFieldError）。
 * 安定キー（id）は不変。当日の評価から反映される（過去日は凍結済みで不変）。
 */
export function updateRule(db: DB, ruleId: number, input: UpdateRuleInput, nowMs = Date.now()): RuleRow {
  const existing = getRule(db, ruleId);
  validateContent(input);
  const reason = requireReason(input.reason);
  const today = todayKey(db, nowMs);

  if (existing.target === 'PHOTO' || input.target === 'PHOTO') {
    const nextCaption = input.target === 'PHOTO' ? (input.caption ?? '').toString().trim() : null;
    if (existing.caption !== null && existing.caption !== nextCaption) throw new RuleImmutableFieldError();
    // PHOTO でなかったルールを PHOTO へ変える場合は「新規キャプション」の指定として許可する
    // （既存キャプションが無い＝まだ何も固定されていない）。
  }

  const tx = db.transaction((): RuleRow => {
    const before = contentSnapshot(existing);
    db.prepare(
      `UPDATE rule SET
         target = @target, comparator = @comparator, threshold_seconds = @threshold, label = @label,
         signal_key = @signal, stable_group_id = @group, group_identity_id = @groupIdentityId,
         caption = @caption, question_text = @question, start_day = @startDay, end_day = @endDay
       WHERE id = @id`,
    ).run({
      id: ruleId,
      target: input.target,
      comparator: input.comparator ?? 'GTE',
      threshold: input.thresholdSeconds ?? null,
      label: (input.label ?? '').toString().trim() || null,
      signal: input.signalKey ?? null,
      group: input.stableGroupId ?? null,
      groupIdentityId: input.groupIdentityId ?? null,
      caption: input.target === 'PHOTO' ? (input.caption ?? existing.caption ?? '').toString().trim() : null,
      question: input.target === 'QUESTION' ? (input.questionText ?? '').toString().trim() : null,
      startDay: input.startDay,
      endDay: input.endDay ?? null,
    });
    const row = getRule(db, ruleId);
    recordChange(db, ruleId, 'update', before, contentSnapshot(row), reason, today, nowMs);
    return row;
  });
  return tx();
}

/**
 * ルールを削除する（reason 必須・design D3・D4）。`status='removed'` にするだけで行は残す
 * （沿革・過去の回答実績とのリンクを保つ）。当日の実効ゲートから外れ、過去日の達成日数は不変。
 */
export function removeRule(db: DB, ruleId: number, reason: string, nowMs = Date.now()): RuleRow {
  const existing = getRule(db, ruleId);
  const r = requireReason(reason);
  const today = todayKey(db, nowMs);
  const tx = db.transaction((): RuleRow => {
    db.prepare("UPDATE rule SET status = 'removed' WHERE id = ?").run(ruleId);
    const row = getRule(db, ruleId);
    recordChange(db, ruleId, 'remove', contentSnapshot(existing), null, r, today, nowMs);
    return row;
  });
  return tx();
}

/**
 * dayKey に「有効」＝実効ゲートへ合流するルールか（design D3 / spec: goal-check-gate）。
 * 繰り越し可（PHOTO/QUESTION 単発）は `start_day` 以降ずっと有効（`end_day` は「単発の当日」を
 * 表すだけの印で上限にならない・達成するまで繰り越す）。それ以外（範囲・時間型・非時間型）は
 * `end_day` を上限として文字どおりに扱う（繰り越さない）。`end_day=null`（永続）は常に無上限。
 */
export function isRuleActiveOn(
  rule: Pick<RuleRow, 'status' | 'target' | 'start_day' | 'end_day'>,
  dayKey: string,
): boolean {
  if (rule.status !== 'active') return false;
  if (dayKey < rule.start_day) return false;
  if (rule.end_day == null) return true;
  const schedule = ruleSchedule(rule.start_day, rule.end_day);
  if (carryoverPolicy(rule.target, schedule) === 'carry') return true;
  return dayKey <= rule.end_day;
}

/** dayKey に「有効」＝実効ゲートへ合流するルール（design D3）。 */
export function listActiveRules(db: DB, dayKey: string): RuleRow[] {
  const candidates = db
    .prepare(`SELECT * FROM rule WHERE status = 'active' AND start_day <= ? ORDER BY id`)
    .all(dayKey) as RuleRow[];
  return candidates.filter((r) => isRuleActiveOn(r, dayKey));
}

export function listAllRules(db: DB): RuleRow[] {
  return db.prepare('SELECT * FROM rule ORDER BY id').all() as RuleRow[];
}

/** ルールのスケジュール種別を導出する（軸2・design D5 / spec: editable-rule-registry）。 */
export function ruleSchedule(startDay: string, endDay: string | null): RuleSchedule {
  if (endDay == null) return 'permanent';
  return startDay === endDay ? 'single' : 'range';
}

export type CarryoverPolicy = 'carry' | 'daily' | 'none';

/**
 * 種類×スケジュールから繰り越し可否を導く純関数（task 2.4 / spec: goal-check-gate）。
 * PHOTO/QUESTION の単発のみ達成まで繰り越す。範囲はその日限り（繰り越さない）。
 * 時間型（TOTAL_WORK/GROUP/TIMELINE）・MANUAL_CHECK・PLANNING は繰り越し無し（毎日の実測で判定）。
 */
export function carryoverPolicy(target: RuleTarget, schedule: RuleSchedule): CarryoverPolicy {
  if (target !== 'PHOTO' && target !== 'QUESTION') return 'none';
  return schedule === 'single' ? 'carry' : 'daily';
}

/**
 * PHOTO/QUESTION ルールが dayKey に「達成済み」か（`carryoverPolicy` と対になる導出・design D5）。
 *   carry（単発） … 回答が1件でもあり、その day_key <= dayKey（提出日以降ずっと met）
 *   daily（範囲・永続） … dayKey ちょうどの回答があるか（前日の達成は今日を助けない）
 */
export function isRuleMetOn(
  target: RuleTarget,
  schedule: RuleSchedule,
  answerDayKeys: readonly string[],
  dayKey: string,
): boolean {
  const policy = carryoverPolicy(target, schedule);
  if (policy === 'carry') return answerDayKeys.some((d) => d <= dayKey);
  return answerDayKeys.some((d) => d === dayKey);
}

/** 範囲ルールの「N日中の何日目か」（1始まり）。範囲外・単発・永続は null。今日タブの表示に使う。 */
export function rangeDayNumber(startDay: string, endDay: string | null, dayKey: string): number | null {
  if (endDay == null || startDay === endDay) return null; // 永続・単発は対象外
  if (dayKey < startDay || dayKey > endDay) return null;
  return dayDiff(startDay, dayKey) + 1;
}

/** 範囲の総日数（N日中の N）。永続・単発は null。 */
export function rangeSpanDays(startDay: string, endDay: string | null): number | null {
  if (endDay == null || startDay === endDay) return null;
  return dayDiff(startDay, endDay) + 1;
}

/** conditionKey='rule:<id>' が一致するエントリを探し、無ければ legacy_condition_key で解決する（design D2）。 */
export function resolveByStableOrLegacy<T extends { conditionKey: string }>(
  results: readonly T[],
  rule: Pick<RuleRow, 'id' | 'legacy_condition_key'>,
): T | undefined {
  const stable = results.find((r) => r.conditionKey === ruleConditionKey(rule.id));
  if (stable) return stable;
  if (!rule.legacy_condition_key) return undefined;
  return results.find((r) => r.conditionKey === rule.legacy_condition_key);
}
