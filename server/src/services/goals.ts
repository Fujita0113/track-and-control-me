import type { DB } from '../db/index.js';
import { nextDayKey } from '../aggregation/index.js';
import { addDaysKey, dayDiff } from './day-key.js';
import { GoalNotFoundError } from './goal-errors.js';
import { getChronicle } from './goal-chronicle.js';
import {
  createRule,
  updateRule,
  removeRule,
  getRule,
  listActiveRules,
  ruleConditionKey,
  ruleSchedule,
  carryoverPolicy,
  isRuleMetOn,
  rangeDayNumber,
  rangeSpanDays,
  resolveByStableOrLegacy,
  RuleNotFoundError,
  type RuleContentInput,
  type RuleRow,
  type RuleTarget,
  type RuleSchedule,
} from './rule-registry.js';
import type { DueRule, RuleAnswer } from '@track/contract';
import { getReflection } from './reflection.js';
import { todayKey } from './summary.js';
import type { ConditionResult } from '../rules/evaluate.js';
import { resolveGroupDisplay } from './group-identity.js';
import type { Chronicle } from '@track/contract';

/**
 * 30日チャレンジ（目標）のライフサイクル・レポート集計・日記（spec: goal-challenge / goal-report /
 * goal-journal / goal-lifecycle-fork / design.md D1-D7）。
 *
 * 「採用」概念は撤廃（`goal_practice` は撤去済み）。目標が追うルールは `goal_rule`（goal_id, rule_id）
 * で紐づき、ルールの中身は常に `rule` テーブルから live に解決する（改名・閾値変更がそのまま反映される）。
 */

export type GoalStatus = 'upcoming' | 'active' | 'completed';
/** 目標の開始日選択（既定=今日）。今日開始は当日を Day1 として即「進行中」（spec: goal-challenge / D3）。 */
export type GoalStart = 'today' | 'tomorrow';

const GOAL_DAYS = 30; // 既定の目標期間（30日固定→前方向にのみ延長されうる・design D7）。
// 時間型（②時間推移の対象）。MANUAL_CHECK / PLANNING / PHOTO / QUESTION は非時間型。
const TIME_TARGETS = new Set<RuleTarget>(['TOTAL_WORK', 'GROUP', 'TIMELINE']);

export class GoalValidationError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'GoalValidationError';
  }
}
export class GoalDeleteWindowError extends Error {
  constructor() {
    super('目標を削除できるのは作成当日のみです');
    this.name = 'GoalDeleteWindowError';
  }
}
/** レポートを開けない＝**開始前**の目標（まだ1日も走っていない）。 */
export class GoalReportNotReadyError extends Error {
  constructor() {
    super('レポートは開始日以降に開けます');
    this.name = 'GoalReportNotReadyError';
  }
}
export class JournalNotWritableError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'JournalNotWritableError';
  }
}
/** 画像データの検証エラー（非対応 mime・サイズ上限超過・不正データ・空）。API は 400。 */
export class JournalImageError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'JournalImageError';
  }
}
/** 画像が見つからない（存在しない、または他目標の画像＝所有不一致）。API は 404。 */
export class JournalImageNotFoundError extends Error {
  constructor() {
    super('画像が見つかりません');
    this.name = 'JournalImageNotFoundError';
  }
}
/**
 * ルールの終端が目標の終了を越えるとき、延長するか切り詰めるかの意思決定を要求する（design D7）。
 * API は 409 で `{ proposedEndDay, goalEndDay }` を返し、UI がフォークを出す。
 */
export class GoalExtensionRequiredError extends Error {
  constructor(
    public readonly proposedEndDay: string,
    public readonly goalEndDay: string,
  ) {
    super(`このルールは目標の終了（${goalEndDay}）を越えます（${proposedEndDay} まで）`);
    this.name = 'GoalExtensionRequiredError';
  }
}
/** 完走フォーク（続ける/終える）の呼び出しが不正（未完走・決定済み）。API は 409。 */
export class GoalLifecycleError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'GoalLifecycleError';
  }
}
/** 写真/質問ルールへの回答の検証エラー（種別不一致・未開始・回答済み・期間外・空回答）。API は 400。 */
export class RuleAnswerError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'RuleAnswerError';
  }
}

interface GoalRow {
  id: number;
  name: string;
  purpose: string;
  start_day: string;
  end_day: string;
  created_at: number;
  lifecycle_choice: 'continued' | 'ended' | null;
  lifecycle_reason: string | null;
  lifecycle_decided_at: number | null;
  continued_goal_id: number | null;
}

export { addDaysKey } from './day-key.js';
export { GoalNotFoundError } from './goal-errors.js';

function getGoalRow(db: DB, id: number): GoalRow {
  const row = db.prepare('SELECT * FROM goal WHERE id = ?').get(id) as GoalRow | undefined;
  if (!row) throw new GoalNotFoundError(id);
  return row;
}

function dayKeyOf(db: DB, ms: number): string {
  return todayKey(db, ms);
}

/** 目標に紐づく全ルール（active/removed 問わず・design D6）。id 昇順。 */
function linkedRules(db: DB, goalId: number): RuleRow[] {
  return db
    .prepare(
      `SELECT r.* FROM goal_rule gr JOIN rule r ON r.id = gr.rule_id WHERE gr.goal_id = ? ORDER BY r.id`,
    )
    .all(goalId) as RuleRow[];
}

function answerDayKeysFor(db: DB, ruleId: number): string[] {
  return (
    db.prepare('SELECT day_key FROM rule_answer WHERE rule_id = ?').all(ruleId) as { day_key: string }[]
  ).map((r) => r.day_key);
}

/** 単発 PHOTO/QUESTION ルールで、まだ未達成のもの（design D7「ぶら下がる全ルールが決着するまで完走しない」）。 */
function unresolvedSingleRules(db: DB, goalId: number, today: string): RuleRow[] {
  return linkedRules(db, goalId).filter((r) => {
    if (r.status !== 'active') return false;
    if (r.target !== 'PHOTO' && r.target !== 'QUESTION') return false;
    if (ruleSchedule(r.start_day, r.end_day) !== 'single') return false;
    return !isRuleMetOn(r.target, 'single', answerDayKeysFor(db, r.id), today);
  });
}

function deriveStatus(db: DB, today: string, goal: GoalRow): GoalStatus {
  if (today < goal.start_day) return 'upcoming';
  if (today <= goal.end_day) return 'active';
  if (unresolvedSingleRules(db, goal.id, today).length > 0) return 'active';
  return 'completed';
}

/** 開始日選択（today|tomorrow）から start_day を算出する。既定は今日（D3）。 */
export function goalStartDay(db: DB, nowMs: number, start: GoalStart): string {
  const today = todayKey(db, nowMs);
  return start === 'tomorrow' ? nextDayKey(today) : today;
}

/** ルールの表示ラベル（現在値から都度解決・改名等が即座に反映される）。 */
function ruleLabel(db: DB, rule: RuleRow): string {
  if (rule.target === 'TOTAL_WORK') return '総作業時間';
  if (rule.target === 'GROUP') {
    const gd = resolveGroupDisplay(db, rule);
    return gd.needsReset ? `${gd.name}（要再設定）` : gd.name;
  }
  if (rule.target === 'TIMELINE') return rule.label ?? 'カテゴリ';
  if (rule.target === 'MANUAL_CHECK') return rule.label ?? '手動チェック';
  if (rule.target === 'PLANNING') return rule.signal_key ?? '翌日計画';
  if (rule.target === 'PHOTO') return rule.caption ?? '写真';
  return rule.question_text ?? '質問'; // QUESTION
}

export interface GoalRuleView {
  ruleId: number;
  conditionKey: string;
  target: RuleTarget;
  label: string;
  schedule: RuleSchedule;
  startDay: string;
  endDay: string | null;
  thresholdSeconds: number | null;
  groupIdentityId: number | null;
  stableGroupId: string | null;
  signalKey: string | null;
  caption: string | null;
  questionText: string | null;
  /** 壊れたルール（GROUP で identity 未解決）。task 7.3「⚠ 参照が壊れています」。 */
  needsReset: boolean;
}

function toRuleView(db: DB, rule: RuleRow): GoalRuleView {
  const needsReset = rule.target === 'GROUP' && resolveGroupDisplay(db, rule).needsReset;
  return {
    ruleId: rule.id,
    conditionKey: ruleConditionKey(rule.id),
    target: rule.target,
    label: ruleLabel(db, rule),
    schedule: ruleSchedule(rule.start_day, rule.end_day),
    startDay: rule.start_day,
    endDay: rule.end_day,
    thresholdSeconds: rule.threshold_seconds,
    groupIdentityId: rule.group_identity_id,
    stableGroupId: rule.stable_group_id,
    signalKey: rule.signal_key,
    caption: rule.caption,
    questionText: rule.question_text,
    needsReset,
  };
}

export interface GoalView {
  id: number;
  name: string;
  purpose: string;
  startDay: string;
  endDay: string;
  createdAt: number;
  status: GoalStatus;
  /** 進行中のとき 1..M、それ以外 null。完走判定が保留（未決着ルールあり）のときは M。 */
  dayNumber: number | null;
  /** M = end_day - start_day + 1（延長されうる・design D7）。 */
  dayCount: number;
  canDelete: boolean;
  rules: GoalRuleView[];
  /** 完走レポート先頭のフォーク（続ける/終える）を出すべきか。 */
  showLifecycleFork: boolean;
  lifecycleChoice: 'continued' | 'ended' | null;
  lifecycleReason: string | null;
  continuedGoalId: number | null;
}

function toGoalView(db: DB, row: GoalRow, today: string, _nowMs: number): GoalView {
  const status = deriveStatus(db, today, row);
  const dayCount = dayDiff(row.start_day, row.end_day) + 1;
  // 進行中は 1..M（未決着ルールで完走が保留されている間は M で頭打ち）。完走後・開始前は null
  // （目標一覧の表示は「完走」の一言で足り、Day N/M はレポートヘッダが担う）。
  const dayNumber = status === 'active' ? Math.min(dayDiff(row.start_day, today) + 1, dayCount) : null;
  return {
    id: row.id,
    name: row.name,
    purpose: row.purpose,
    startDay: row.start_day,
    endDay: row.end_day,
    createdAt: row.created_at,
    status,
    dayNumber,
    dayCount,
    canDelete: dayKeyOf(db, row.created_at) === today,
    rules: linkedRules(db, row.id)
      .filter((r) => r.status === 'active')
      .map((r) => toRuleView(db, r)),
    showLifecycleFork: status === 'completed' && row.lifecycle_choice === null,
    lifecycleChoice: row.lifecycle_choice,
    lifecycleReason: row.lifecycle_reason,
    continuedGoalId: row.continued_goal_id,
  };
}

// --- 作成 -------------------------------------------------------------------

/** 目標作成時にその場で作るルール（target 別の入力＋いつ＋理由・spec: goal-inline-condition）。 */
export interface NewGoalRuleInput {
  target: RuleTarget;
  thresholdSeconds?: number | null;
  label?: string | null;
  signalKey?: string | null;
  groupIdentityId?: number | null;
  /** @deprecated identity 参照に置き換え済み。壊れた旧参照の据え置き・移行専用。 */
  stableGroupId?: string | null;
  caption?: string | null;
  questionText?: string | null;
  /** 省略時: 目標作成時は目標の開始日、既存目標への追加時は今日。 */
  startDay?: string;
  /** 省略時は永続（null）。 */
  endDay?: string | null;
  reason: string;
}

export interface CreateGoalInput {
  name: string;
  purpose?: string;
  start?: GoalStart;
  /** この目標のためにその場で作るルール（1つ以上・spec: goal-challenge）。 */
  rules: NewGoalRuleInput[];
}

export interface AddRuleResult {
  rule: RuleRow;
  /** 'truncate' を選び、ルールを目標末尾まで切り詰めた場合 true（design D7）。 */
  truncated: boolean;
}

/**
 * 目標にルールを追加する（新規作成 or 目標コーナーからの追加・design D6・D7）。
 * ルールの終端が目標の終了を越えるときは `opts.extend` を要求する
 * （未指定なら `GoalExtensionRequiredError`）。
 */
export function addRuleToGoal(
  db: DB,
  goalId: number,
  input: NewGoalRuleInput,
  opts: { extend?: 'extend' | 'truncate' } = {},
  nowMs = Date.now(),
): AddRuleResult {
  const goal = getGoalRow(db, goalId);
  let startDay = input.startDay ?? todayKey(db, nowMs);
  let endDay = input.endDay ?? null;
  let truncated = false;

  if (endDay != null && endDay > goal.end_day) {
    if (!opts.extend) throw new GoalExtensionRequiredError(endDay, goal.end_day);
    if (opts.extend === 'extend') {
      db.prepare('UPDATE goal SET end_day = ? WHERE id = ? AND end_day < ?').run(endDay, goalId, endDay);
    } else {
      // 'truncate': ルールを目標末尾まで切り詰める（範囲短縮）。単発は目標末尾へ移動。
      endDay = goal.end_day;
      if (startDay > endDay) startDay = endDay;
      truncated = true;
    }
  }

  const tx = db.transaction((): AddRuleResult => {
    const rule = createRule(db, { ...input, startDay, endDay, reason: input.reason } as RuleContentInput & { reason: string }, nowMs);
    db.prepare('INSERT OR IGNORE INTO goal_rule (goal_id, rule_id) VALUES (?, ?)').run(goalId, rule.id);
    return { rule, truncated };
  });
  return tx();
}

/**
 * 目標を作成する。開始日は今日／明日の選択式（既定=今日）、期間は30日固定（延長されうる）。
 * ルールはその場で新規作成し自動で紐づける（「採用」の明示選択は廃止・spec: goal-inline-condition）。
 * 作成と紐づけは一体の操作で、途中の失敗（バリデーション・拡張要求）は全体 rollback する。
 */
export function createGoal(db: DB, input: CreateGoalInput, nowMs = Date.now()): GoalView {
  const name = (input.name ?? '').trim();
  if (!name) throw new GoalValidationError('目標名は必須です');
  const rules = input.rules ?? [];
  if (rules.length === 0) throw new GoalValidationError('ルールを1つ以上追加してください');
  const start: GoalStart = input.start === 'tomorrow' ? 'tomorrow' : 'today';
  const startDay = goalStartDay(db, nowMs, start);
  const endDay = addDaysKey(startDay, GOAL_DAYS - 1);

  const tx = db.transaction((): number => {
    const info = db
      .prepare('INSERT INTO goal (name, purpose, start_day, end_day, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(name, (input.purpose ?? '').trim(), startDay, endDay, nowMs);
    const goalId = info.lastInsertRowid as number;
    for (const r of rules) {
      addRuleToGoal(db, goalId, { ...r, startDay: r.startDay ?? startDay }, {}, nowMs);
    }
    return goalId;
  });
  const goalId = tx();
  return toGoalView(db, getGoalRow(db, goalId), todayKey(db, nowMs), nowMs);
}

/** 目標一覧（導出 status 付き）。開始前・進行中・完走の順は日付降順。 */
export function listGoals(db: DB, nowMs = Date.now()): GoalView[] {
  const today = todayKey(db, nowMs);
  const rows = db.prepare('SELECT * FROM goal ORDER BY start_day DESC, id DESC').all() as GoalRow[];
  return rows.map((r) => toGoalView(db, r, today, nowMs));
}

export function getGoal(db: DB, id: number, nowMs = Date.now()): GoalView {
  return toGoalView(db, getGoalRow(db, id), todayKey(db, nowMs), nowMs);
}

/** 作成当日限りの削除（誤作成の救済）。CASCADE で紐づけ・日記も消える（ルール本体は残る）。 */
export function deleteGoal(db: DB, id: number, nowMs = Date.now()): boolean {
  const row = getGoalRow(db, id);
  const today = todayKey(db, nowMs);
  if (dayKeyOf(db, row.created_at) !== today) throw new GoalDeleteWindowError();
  return db.prepare('DELETE FROM goal WHERE id = ?').run(id).changes > 0;
}

// --- 目標コーナー: ルールの編集・削除（spec: editable-rule-registry / goal-challenge）----------

/** 目標コーナーからルールを編集する（理由必須・延長フォークもここで発生しうる）。 */
export function updateGoalRule(
  db: DB,
  goalId: number,
  ruleId: number,
  input: RuleContentInput & { reason: string },
  opts: { extend?: 'extend' | 'truncate' } = {},
  nowMs = Date.now(),
): AddRuleResult {
  const goal = getGoalRow(db, goalId);
  const link = db.prepare('SELECT 1 FROM goal_rule WHERE goal_id = ? AND rule_id = ?').get(goalId, ruleId);
  if (!link) throw new RuleNotFoundError(ruleId);

  let startDay = input.startDay;
  let endDay = input.endDay ?? null;
  let truncated = false;
  if (endDay != null && endDay > goal.end_day) {
    if (!opts.extend) throw new GoalExtensionRequiredError(endDay, goal.end_day);
    if (opts.extend === 'extend') {
      db.prepare('UPDATE goal SET end_day = ? WHERE id = ? AND end_day < ?').run(endDay, goalId, endDay);
    } else {
      endDay = goal.end_day;
      if (startDay > endDay) startDay = endDay;
      truncated = true;
    }
  }

  const rule = updateRule(db, ruleId, { ...input, startDay, endDay, reason: input.reason }, nowMs);
  return { rule, truncated };
}

/** 目標コーナーからルールを削除する（理由必須・ジャンル固定なし・design D3）。 */
export function removeGoalRule(db: DB, goalId: number, ruleId: number, reason: string, nowMs = Date.now()): RuleRow {
  const link = db.prepare('SELECT 1 FROM goal_rule WHERE goal_id = ? AND rule_id = ?').get(goalId, ruleId);
  if (!link) throw new RuleNotFoundError(ruleId);
  return removeRule(db, ruleId, reason, nowMs);
}

// --- 完走フォーク（続ける/終える・spec: goal-lifecycle-fork）---------------

function requireCompletedUnforked(db: DB, goalId: number, nowMs: number): GoalRow {
  const goal = getGoalRow(db, goalId);
  const today = todayKey(db, nowMs);
  if (deriveStatus(db, today, goal) !== 'completed') throw new GoalLifecycleError('目標はまだ完走していません');
  if (goal.lifecycle_choice) throw new GoalLifecycleError('この目標のフォークは決定済みです');
  return goal;
}

/**
 * 続ける: 新しい30日目標を作り直す（Day 1/30）。永続ルール（end_day=null・status='active'）は
 * 新目標へ紐づけ続投する（既に期日を終えた単発/範囲ルールは復活しない）。前サイクルのレポートは残る。
 */
export function continueGoal(db: DB, goalId: number, nowMs = Date.now()): GoalView {
  const goal = requireCompletedUnforked(db, goalId, nowMs);
  const today = todayKey(db, nowMs);
  const newEndDay = addDaysKey(today, GOAL_DAYS - 1);

  const tx = db.transaction((): number => {
    const info = db
      .prepare('INSERT INTO goal (name, purpose, start_day, end_day, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(goal.name, goal.purpose, today, newEndDay, nowMs);
    const newGoalId = info.lastInsertRowid as number;
    const permanentRules = linkedRules(db, goal.id).filter((r) => r.status === 'active' && r.end_day === null);
    for (const r of permanentRules) {
      db.prepare('INSERT OR IGNORE INTO goal_rule (goal_id, rule_id) VALUES (?, ?)').run(newGoalId, r.id);
    }
    db.prepare(
      "UPDATE goal SET lifecycle_choice = 'continued', lifecycle_decided_at = ?, continued_goal_id = ? WHERE id = ?",
    ).run(nowMs, newGoalId, goal.id);
    return newGoalId;
  });
  const newGoalId = tx();
  return toGoalView(db, getGoalRow(db, newGoalId), todayKey(db, nowMs), nowMs);
}

/**
 * 終える（理由任意）: 永続ルールをゲートから外す（`status='removed'`）。目標は完走・終了として
 * アーカイブされる（レポート・沿革・カレンダーは読めるまま残す）。理由を書けば沿革の最終エントリに残る。
 */
export function endGoal(db: DB, goalId: number, reason: string | undefined, nowMs = Date.now()): GoalView {
  const goal = requireCompletedUnforked(db, goalId, nowMs);
  const r = (reason ?? '').trim();

  const tx = db.transaction(() => {
    const permanentRules = linkedRules(db, goal.id).filter((x) => x.status === 'active' && x.end_day === null);
    for (const rule of permanentRules) removeRule(db, rule.id, r || '目標を終える', nowMs);
    db.prepare(
      "UPDATE goal SET lifecycle_choice = 'ended', lifecycle_reason = ?, lifecycle_decided_at = ? WHERE id = ?",
    ).run(r || null, nowMs, goal.id);
  });
  tx();
  return toGoalView(db, getGoalRow(db, goal.id), todayKey(db, nowMs), nowMs);
}

// --- 日記（spec: goal-journal / D4）--------------------------------------

export interface JournalRow {
  goal_id: number;
  day_key: string;
  content: string;
  created_at: number;
  updated_at: number;
}

export function getJournal(db: DB, goalId: number, dayKey: string): { content: string } {
  const row = db
    .prepare('SELECT content FROM goal_journal WHERE goal_id = ? AND day_key = ?')
    .get(goalId, dayKey) as { content: string } | undefined;
  return { content: row?.content ?? '' };
}

/** 日記の書き込みは目標が進行中の日のみ許可（完走後・開始前は拒否・D4）。 */
export function saveJournal(
  db: DB,
  goalId: number,
  dayKey: string,
  content: string,
  nowMs = Date.now(),
): { content: string } {
  const row = getGoalRow(db, goalId);
  const today = todayKey(db, nowMs);
  const status = deriveStatus(db, today, row);
  if (status !== 'active')
    throw new JournalNotWritableError(
      status === 'completed' ? '完走した目標の日記は編集できません' : '開始前の目標には記入できません',
    );
  if (dayKey < row.start_day || dayKey > row.end_day)
    throw new JournalNotWritableError('目標期間外の日には記入できません');
  const now = nowMs;
  db.prepare(
    `INSERT INTO goal_journal (goal_id, day_key, content, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(goal_id, day_key) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`,
  ).run(goalId, dayKey, String(content ?? ''), now, now);
  return getJournal(db, goalId, dayKey);
}

// --- 目標日記の画像添付（spec: goal-journal / D1–D4）----------------------

/** 保存を許す画像 mime（design D2）。 */
const IMAGE_MIME_ALLOW = new Set(['image/jpeg', 'image/png', 'image/webp']);
/** デコード後バイト数の上限（design D2・目安5MB）。 */
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;

export interface JournalImageMeta {
  imageId: number;
  caption: string;
  mime: string;
  width: number | null;
  height: number | null;
  sortOrder: number;
}
export interface AddJournalImageInput {
  dataUrl: string;
  caption?: string;
  width?: number | null;
  height?: number | null;
}

/** data URL（`data:<mime>;base64,<payload>`）を mime とバイト列へ分解する。 */
function parseDataUrl(dataUrl: string): { mime: string; bytes: Buffer } {
  const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(String(dataUrl ?? ''));
  if (!m) throw new JournalImageError('画像データが不正です');
  const mime = m[1]!.toLowerCase();
  const bytes = m[2] ? Buffer.from(m[3]!, 'base64') : Buffer.from(decodeURIComponent(m[3]!));
  return { mime, bytes };
}

/** 所有検証つきで画像メタを1件取得（他目標の画像・不在は JournalImageNotFoundError）。 */
function imageMetaById(db: DB, goalId: number, imageId: number): JournalImageMeta {
  const r = db
    .prepare(
      'SELECT id, caption, mime, width, height, sort_order FROM goal_journal_image WHERE id = ? AND goal_id = ?',
    )
    .get(imageId, goalId) as
    | { id: number; caption: string; mime: string; width: number | null; height: number | null; sort_order: number }
    | undefined;
  if (!r) throw new JournalImageNotFoundError();
  return { imageId: r.id, caption: r.caption, mime: r.mime, width: r.width, height: r.height, sortOrder: r.sort_order };
}

/** その日の画像メタ一覧（sort_order 昇順・バイトは含めない）。読み取りは status 非依存。 */
export function listJournalImages(db: DB, goalId: number, dayKey: string): JournalImageMeta[] {
  getGoalRow(db, goalId); // 存在確認（無ければ 404）。
  return (
    db
      .prepare(
        'SELECT id, caption, mime, width, height, sort_order FROM goal_journal_image WHERE goal_id = ? AND day_key = ? ORDER BY sort_order, id',
      )
      .all(goalId, dayKey) as {
      id: number;
      caption: string;
      mime: string;
      width: number | null;
      height: number | null;
      sort_order: number;
    }[]
  ).map((r) => ({
    imageId: r.id,
    caption: r.caption,
    mime: r.mime,
    width: r.width,
    height: r.height,
    sortOrder: r.sort_order,
  }));
}

/**
 * 画像を1枚追加する（状態は問わない・いつでも可・design D4b）。
 * `day_key ∈ [start,end]` のみ検証（期間外は 400）。base64 デコード → mime 許可リスト・サイズ上限を検証
 * → sort_order＝当日最大+1 で INSERT。本文行（goal_journal）は作らない＝本文が空の日でも画像だけ保存できる。
 */
export function addJournalImage(
  db: DB,
  goalId: number,
  dayKey: string,
  input: AddJournalImageInput,
  nowMs = Date.now(),
): JournalImageMeta {
  const row = getGoalRow(db, goalId); // 存在確認（無ければ 404）。status は問わない。
  if (dayKey < row.start_day || dayKey > row.end_day)
    throw new JournalImageError('目標期間外の日には追加できません');
  const { mime, bytes } = parseDataUrl(input.dataUrl);
  if (!IMAGE_MIME_ALLOW.has(mime))
    throw new JournalImageError('対応していない画像形式です（JPEG / PNG / WebP のみ）');
  if (bytes.length === 0) throw new JournalImageError('画像データが空です');
  if (bytes.length > IMAGE_MAX_BYTES) throw new JournalImageError('画像サイズが上限（5MB）を超えています');

  const caption = String(input.caption ?? '').trim();
  const width = input.width ?? null;
  const height = input.height ?? null;
  const nextSort = (
    db
      .prepare(
        'SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM goal_journal_image WHERE goal_id = ? AND day_key = ?',
      )
      .get(goalId, dayKey) as { n: number }
  ).n;
  const info = db
    .prepare(
      `INSERT INTO goal_journal_image (goal_id, day_key, caption, mime, bytes, width, height, sort_order, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(goalId, dayKey, caption, mime, bytes, width, height, nextSort, nowMs);
  return { imageId: info.lastInsertRowid as number, caption, mime, width, height, sortOrder: nextSort };
}

/** 画像バイナリを取得（所有検証つき・読み取りは status 非依存）。 */
export function getJournalImageBytes(db: DB, goalId: number, imageId: number): { mime: string; bytes: Buffer } {
  const r = db
    .prepare('SELECT mime, bytes FROM goal_journal_image WHERE id = ? AND goal_id = ?')
    .get(imageId, goalId) as { mime: string; bytes: Buffer } | undefined;
  if (!r) throw new JournalImageNotFoundError();
  return { mime: r.mime, bytes: r.bytes };
}

/** キャプション更新（所有検証のみ・状態は問わない・design D4b）。 */
export function updateJournalImageCaption(
  db: DB,
  goalId: number,
  imageId: number,
  caption: string,
): JournalImageMeta {
  const meta = imageMetaById(db, goalId, imageId); // 所有検証（他目標・不在は 404）。
  const next = String(caption ?? '').trim();
  db.prepare('UPDATE goal_journal_image SET caption = ? WHERE id = ? AND goal_id = ?').run(next, imageId, goalId);
  return { ...meta, caption: next };
}

/** 画像削除（所有検証のみ・状態は問わない・design D4b）。 */
export function deleteJournalImage(db: DB, goalId: number, imageId: number): boolean {
  imageMetaById(db, goalId, imageId); // 所有検証（他目標・不在は 404）。
  return db.prepare('DELETE FROM goal_journal_image WHERE id = ? AND goal_id = ?').run(imageId, goalId).changes > 0;
}

// --- レポート集計（spec: goal-report / D5・D6）-----------------------------

export interface ReportDayCell {
  dayKey: string;
  dayNumber: number;
  met: boolean;
  actualSeconds: number | null;
  thresholdSeconds: number | null;
  /** まだ到来していない日（`day_key > today`）＝**未到来**。未達成マスにしない（design D6）。 */
  future: boolean;
  /** このルールがその日ゲートに含まれていなかった（開始前・削除後）＝**対象外**。未達成に数えない。 */
  inactive: boolean;
}
export interface ReportRule {
  ruleId: number;
  conditionKey: string;
  target: RuleTarget;
  label: string;
  isTimeType: boolean;
  cells: ReportDayCell[];
}
export interface ReportRuleChange {
  ruleId: number;
  label: string;
  effectiveDate: string;
  dayNumber: number;
  op: 'add' | 'update' | 'remove';
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  reason: string;
}
export interface ReportDayImage {
  imageId: number;
  caption: string;
}
/** ③の2モード用の平坦な画像メタ（キャプション横断・日跨ぎの並びに使う・design D5）。 */
export interface ReportImage {
  imageId: number;
  caption: string;
  dayKey: string;
  dayNumber: number;
  sortOrder: number;
}
export interface ReportDayText {
  dayKey: string;
  dayNumber: number;
  text: string;
  source: 'journal' | 'reflection' | null;
  /** その日に添付された画像（sort_order 昇順）。③は Day1/Day30、④は各日で使う（D5）。 */
  images: ReportDayImage[];
}
export interface GoalReport {
  goal: {
    id: number;
    name: string;
    purpose: string;
    startDay: string;
    endDay: string;
    /** M = end_day - start_day + 1（延長されうる・design D7）。 */
    dayCount: number;
    /** 達成日数＝当日ゲートに含まれた全ルール met の日数。進行中は**その時点まで**（未到来は数えない）。 */
    achievedDays: number;
    /** 進行中（走行中プレビュー）か完走後か。UI の文言・CTA 出し分けに使う。 */
    status: GoalStatus;
    /** 進行中は 1..M（Day 12/30 のヘッダ用）、完走後は M。 */
    dayNumber: number;
    /** 事実が確定している日数（＝未到来でない日の数）。進行中は dayNumber と一致。 */
    elapsedDays: number;
    /**
     * ③の After 側に使う Day 番号。完走後は最終日、進行中は**現時点で最も新しい
     * 記録のある日**（記録が1つも無ければ現在の Day）（spec: goal-report ③）。
     */
    afterDayNumber: number;
    /** ③の最終日写真 CTA を出してよいか＝**完走後のみ**（進行中は最終日がまだ来ていない）。 */
    showFinalPhotoCta: boolean;
    /** 完走レポート先頭の「続ける／終える」フォークを出すべきか（design: goal-lifecycle-fork）。 */
    showLifecycleFork: boolean;
    lifecycleChoice: 'continued' | 'ended' | null;
    lifecycleReason: string | null;
    continuedGoalId: number | null;
  };
  rules: ReportRule[];
  hasTimeType: boolean;
  ruleChanges: ReportRuleChange[];
  days: ReportDayText[];
  /** 全画像の平坦リスト（(caption, dayNumber, sortOrder) 昇順）。③の2モードが使う（D5）。 */
  reportImages: ReportImage[];
  /** ⑤沿革（ルール操作の年表）。日記は含まない（spec: goal-chronicle）。 */
  chronicle: Chronicle;
}

interface RuleChangeDbRow {
  id: number;
  rule_id: number;
  day_key: string;
  op: 'add' | 'update' | 'remove';
  before: string | null;
  after: string | null;
  reason: string;
}

/**
 * 目標のレポートを集計する。**進行中でも開ける**（走行中プレビュー・spec: goal-report / D6）。
 * 開始前（まだ1日も走っていない）のみ GoalReportNotReadyError（API は 409）。
 */
export function getGoalReport(db: DB, id: number, nowMs = Date.now()): GoalReport {
  const goal = getGoalRow(db, id);
  const today = todayKey(db, nowMs);
  const status = deriveStatus(db, today, goal);
  if (status === 'upcoming') throw new GoalReportNotReadyError();
  const completed = status === 'completed';
  const dayCount = dayDiff(goal.start_day, goal.end_day) + 1;
  // 事実が確定している日数（＝未到来でない日）。完走後は全日。
  const elapsedDays = completed ? dayCount : Math.min(dayCount, dayDiff(goal.start_day, today) + 1);

  const rules = linkedRules(db, id);
  const ruleChanges = rules.length
    ? (db
        .prepare(
          `SELECT * FROM rule_change WHERE rule_id IN (${rules.map(() => '?').join(',')}) ORDER BY day_key, id`,
        )
        .all(...rules.map((r) => r.id)) as RuleChangeDbRow[])
    : [];

  // 各ルールが dayKey に「実際にゲートにあったか」（design D1・D3。isRuleActiveOn の履歴版）。
  // `rule_change`（op='add'）の day_key は「その変更を決めた日」で、スケジュール開始（start_day）
  // より前のことがあるため境界には使わない。削除済みは最後の remove 日以降を対象外にする。
  const removedAt = new Map<number, string | null>();
  for (const r of rules) {
    const removeRow = [...ruleChanges].reverse().find((c) => c.rule_id === r.id && c.op === 'remove');
    removedAt.set(r.id, removeRow?.day_key ?? null);
  }
  function wasActiveOn(r: RuleRow, dayKey: string): boolean {
    if (dayKey < r.start_day) return false;
    const removedDay = removedAt.get(r.id) ?? null;
    if (removedDay !== null && dayKey >= removedDay) return false;
    if (r.end_day == null) return true;
    const schedule = ruleSchedule(r.start_day, r.end_day);
    if (carryoverPolicy(r.target, schedule) === 'carry') return true;
    return dayKey <= r.end_day;
  }

  const dayKeys: string[] = [];
  for (let i = 0; i < dayCount; i++) dayKeys.push(addDaysKey(goal.start_day, i));

  // 各日の per_condition_results（rule:<id> または legacy_condition_key で解決）。
  const evalByDay = new Map<string, ConditionResult[]>();
  for (const row of db
    .prepare('SELECT day_key, per_condition_results FROM unlock_evaluation WHERE day_key BETWEEN ? AND ?')
    .all(goal.start_day, goal.end_day) as { day_key: string; per_condition_results: string }[]) {
    try {
      evalByDay.set(row.day_key, JSON.parse(row.per_condition_results) as ConditionResult[]);
    } catch {
      evalByDay.set(row.day_key, []); // 壊れた JSON は空扱い（欠測＝未達成）。
    }
  }

  // ① ルールごとの M日カレンダー（欠測・キー不在は未達成／未到来は空白／対象外期間は inactive）。
  const reportRules: ReportRule[] = rules.map((r) => {
    const cells: ReportDayCell[] = dayKeys.map((dk, i) => {
      const future = dk > today;
      const inactive = !future && !wasActiveOn(r, dk);
      const entry = future || inactive ? undefined : resolveByStableOrLegacy(evalByDay.get(dk) ?? [], r);
      return {
        dayKey: dk,
        dayNumber: i + 1,
        met: !future && !inactive && entry?.met === true,
        actualSeconds: future || inactive ? null : (entry?.actualSeconds ?? null),
        thresholdSeconds: future || inactive ? null : (entry?.thresholdSeconds ?? null),
        future,
        inactive,
      };
    });
    return {
      ruleId: r.id,
      conditionKey: ruleConditionKey(r.id),
      target: r.target,
      label: ruleLabel(db, r),
      isTimeType: TIME_TARGETS.has(r.target),
      cells,
    };
  });

  // ヘッダ達成日数 = その日ゲートにあった（inactive でない）ルールが1つ以上あり、全て met の日数。
  let achievedDays = 0;
  for (let i = 0; i < elapsedDays; i++) {
    const applicable = reportRules.filter((r) => !r.cells[i]!.inactive);
    if (applicable.length > 0 && applicable.every((r) => r.cells[i]!.met)) achievedDays++;
  }

  // ② 時間型ルールの閾値変更マーカー（②時間推移グラフの注釈・design D2）。写真/質問ルールの
  // 追加・削除など一般のルール操作履歴は⑤沿革が読み手（ここでは二重に載せない）。
  const reportRuleChanges: ReportRuleChange[] = ruleChanges
    .filter((c) => c.day_key >= goal.start_day && c.day_key <= goal.end_day && c.op === 'update')
    .filter((c) => {
      const rule = rules.find((r) => r.id === c.rule_id);
      return rule && TIME_TARGETS.has(rule.target);
    })
    .map((c) => {
      const rule = rules.find((r) => r.id === c.rule_id);
      return {
        ruleId: c.rule_id,
        label: rule ? ruleLabel(db, rule) : `rule:${c.rule_id}`,
        effectiveDate: c.day_key,
        dayNumber: dayDiff(goal.start_day, c.day_key) + 1,
        op: c.op,
        before: c.before ? (JSON.parse(c.before) as Record<string, unknown>) : null,
        after: c.after ? (JSON.parse(c.after) as Record<string, unknown>) : null,
        reason: c.reason,
      };
    });

  // ③④ Day 別文面（goal_journal → reflection_entry の日単位フォールバック）。
  const journalByDay = new Map(
    (db.prepare('SELECT day_key, content FROM goal_journal WHERE goal_id = ?').all(id) as {
      day_key: string;
      content: string;
    }[]).map((r) => [r.day_key, r.content]),
  );
  const imagesByDay = new Map<string, ReportDayImage[]>();
  const reportImages: ReportImage[] = [];
  for (const r of db
    .prepare('SELECT id, day_key, caption, sort_order FROM goal_journal_image WHERE goal_id = ? ORDER BY day_key, sort_order, id')
    .all(id) as { id: number; day_key: string; caption: string; sort_order: number }[]) {
    if (!imagesByDay.has(r.day_key)) imagesByDay.set(r.day_key, []);
    imagesByDay.get(r.day_key)!.push({ imageId: r.id, caption: r.caption });
    reportImages.push({
      imageId: r.id,
      caption: r.caption,
      dayKey: r.day_key,
      dayNumber: dayDiff(goal.start_day, r.day_key) + 1,
      sortOrder: r.sort_order,
    });
  }
  reportImages.sort(
    (a, b) =>
      a.caption.trim().localeCompare(b.caption.trim()) || a.dayNumber - b.dayNumber || a.sortOrder - b.sortOrder,
  );
  const days: ReportDayText[] = dayKeys.map((dk, i) => {
    const images = imagesByDay.get(dk) ?? [];
    const j = journalByDay.get(dk);
    if (j && j.trim()) return { dayKey: dk, dayNumber: i + 1, text: j, source: 'journal', images };
    const ref = getReflection(db, dk);
    if (ref && ref.content && ref.content.trim())
      return { dayKey: dk, dayNumber: i + 1, text: ref.content, source: 'reflection', images };
    return { dayKey: dk, dayNumber: i + 1, text: '', source: null, images };
  });

  let afterDayNumber = elapsedDays;
  if (completed) {
    afterDayNumber = dayCount;
  } else {
    for (let i = elapsedDays - 1; i >= 0; i--) {
      const d = days[i]!;
      if (d.text.trim() || d.images.length > 0) {
        afterDayNumber = d.dayNumber;
        break;
      }
    }
  }

  return {
    goal: {
      id: goal.id,
      name: goal.name,
      purpose: goal.purpose,
      startDay: goal.start_day,
      endDay: goal.end_day,
      dayCount,
      achievedDays,
      status,
      dayNumber: elapsedDays,
      elapsedDays,
      afterDayNumber,
      showFinalPhotoCta: completed,
      showLifecycleFork: completed && goal.lifecycle_choice === null,
      lifecycleChoice: goal.lifecycle_choice,
      lifecycleReason: goal.lifecycle_reason,
      continuedGoalId: goal.continued_goal_id,
    },
    rules: reportRules,
    hasTimeType: reportRules.some((r) => r.isTimeType),
    ruleChanges: reportRuleChanges,
    days,
    reportImages,
    chronicle: getChronicle(db, id, today),
  };
}

// --- 写真/質問ルールへの回答（今日タブの不足条件・spec: goal-check-gate）--------------------

/** ルールに紐づく最初の目標（id 昇順・design D6）。PHOTO/QUESTION は必ずどこかの目標に属する想定。 */
function primaryGoalForRule(db: DB, ruleId: number): { id: number; name: string } | undefined {
  return db
    .prepare(
      `SELECT g.id AS id, g.name AS name FROM goal_rule gr JOIN goal g ON g.id = gr.goal_id
        WHERE gr.rule_id = ? ORDER BY g.id LIMIT 1`,
    )
    .get(ruleId) as { id: number; name: string } | undefined;
}

function toRuleAnswerView(row: {
  id: number;
  rule_id: number;
  day_key: string;
  image_id: number | null;
  answer_text: string | null;
  created_at: number;
}): RuleAnswer {
  return {
    id: row.id,
    ruleId: row.rule_id,
    dayKey: row.day_key,
    dayNumber: null, // 目標コンテキスト無しの生回答（沿革側は goal-chronicle.ts が dayNumber を埋める）。
    imageId: row.image_id,
    answerText: row.answer_text,
    createdAt: row.created_at,
  };
}

/** 回答受け付け前の共通検証（有効なルールか・その日に要求されているか）。 */
function requireAnswerableRule(db: DB, ruleId: number, dayKey: string): RuleRow {
  const rule = getRule(db, ruleId);
  if (rule.target !== 'PHOTO' && rule.target !== 'QUESTION')
    throw new RuleAnswerError('このルールは写真/質問の回答先ではありません');
  if (rule.status !== 'active') throw new RuleAnswerError('このルールは削除済みです');
  if (dayKey < rule.start_day) throw new RuleAnswerError('このルールはまだ始まっていません');
  const schedule = ruleSchedule(rule.start_day, rule.end_day);
  if (schedule === 'range' && rule.end_day !== null && dayKey > rule.end_day)
    throw new RuleAnswerError('範囲ルールの期間を過ぎています（後から埋めることはできません）');
  const answerDayKeys = (
    db.prepare('SELECT day_key FROM rule_answer WHERE rule_id = ?').all(ruleId) as { day_key: string }[]
  ).map((r) => r.day_key);
  if (isRuleMetOn(rule.target, schedule, answerDayKeys, dayKey))
    throw new RuleAnswerError('このルールには既に回答済みです');
  return rule;
}

/** 写真ルールへ提出する（キャプションは先指定のため受け取らない・design D5）。 */
export function submitRulePhoto(
  db: DB,
  ruleId: number,
  dayKey: string,
  input: { dataUrl: string; width?: number | null; height?: number | null },
  nowMs = Date.now(),
): RuleAnswer {
  const rule = requireAnswerableRule(db, ruleId, dayKey);
  if (rule.target !== 'PHOTO') throw new RuleAnswerError('このルールは写真の提出先ではありません');
  if (!input.dataUrl) throw new RuleAnswerError('画像を選択してください');
  const goal = primaryGoalForRule(db, ruleId);
  if (!goal) throw new RuleAnswerError('このルールはどの目標にも紐づいていません');

  const tx = db.transaction((): number => {
    const img = addJournalImage(
      db,
      goal.id,
      dayKey,
      { dataUrl: input.dataUrl, caption: rule.caption ?? '', width: input.width ?? null, height: input.height ?? null },
      nowMs,
    );
    const info = db
      .prepare('INSERT INTO rule_answer (rule_id, day_key, image_id, answer_text, created_at) VALUES (?, ?, ?, NULL, ?)')
      .run(ruleId, dayKey, img.imageId, nowMs);
    return info.lastInsertRowid as number;
  });
  const answerId = tx();
  return toRuleAnswerView(
    db.prepare('SELECT * FROM rule_answer WHERE id = ?').get(answerId) as {
      id: number;
      rule_id: number;
      day_key: string;
      image_id: number | null;
      answer_text: string | null;
      created_at: number;
    },
  );
}

/** 質問ルールへ回答する（空回答は拒否）。 */
export function answerRuleQuestion(
  db: DB,
  ruleId: number,
  dayKey: string,
  answerText: string,
  nowMs = Date.now(),
): RuleAnswer {
  const rule = requireAnswerableRule(db, ruleId, dayKey);
  if (rule.target !== 'QUESTION') throw new RuleAnswerError('このルールは質問への回答先ではありません');
  const text = String(answerText ?? '').trim();
  if (!text) throw new RuleAnswerError('答えを入力してください');
  const info = db
    .prepare('INSERT INTO rule_answer (rule_id, day_key, image_id, answer_text, created_at) VALUES (?, ?, NULL, ?, ?)')
    .run(ruleId, dayKey, text, nowMs);
  return toRuleAnswerView(
    db.prepare('SELECT * FROM rule_answer WHERE id = ?').get(info.lastInsertRowid as number) as {
      id: number;
      rule_id: number;
      day_key: string;
      image_id: number | null;
      answer_text: string | null;
      created_at: number;
    },
  );
}

/**
 * その日に**回答すべき**（有効かつ未達の）写真/質問ルール（今日タブの不足条件・初回トースト）。
 */
export function listDueRules(db: DB, dayKey: string): DueRule[] {
  const out: DueRule[] = [];
  for (const rule of listActiveRules(db, dayKey)) {
    if (rule.target !== 'PHOTO' && rule.target !== 'QUESTION') continue;
    const schedule = ruleSchedule(rule.start_day, rule.end_day);
    const answerDayKeys = (
      db.prepare('SELECT day_key FROM rule_answer WHERE rule_id = ?').all(rule.id) as { day_key: string }[]
    ).map((r) => r.day_key);
    if (isRuleMetOn(rule.target, schedule, answerDayKeys, dayKey)) continue;
    const goal = primaryGoalForRule(db, rule.id);
    out.push({
      ruleId: rule.id,
      goalId: goal?.id ?? null,
      goalName: goal?.name ?? null,
      target: rule.target,
      label: rule.target === 'PHOTO' ? (rule.caption ?? '') : (rule.question_text ?? ''),
      schedule,
      startDay: rule.start_day,
      endDay: rule.end_day,
      rangeDayNumber: rangeDayNumber(rule.start_day, rule.end_day, dayKey),
      spanDays: rangeSpanDays(rule.start_day, rule.end_day),
    });
  }
  return out;
}
