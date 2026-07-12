import type { DB } from '../db/index.js';
import { nextDayKey } from '../aggregation/index.js';
import {
  getEffectiveRuleSet,
  upsertFutureRuleSet,
  type ConditionInput,
  type RuleConditionRow,
} from '../rules/rules.js';
import { getReflection } from './reflection.js';
import { todayKey } from './summary.js';
import type { ConditionResult } from '../rules/evaluate.js';

/**
 * 30日チャレンジ（目標）のライフサイクル・レポート集計・日記（spec: goal-challenge /
 * goal-report / goal-journal / design.md D1–D6）。
 * 既存の計測・評価・凍結機構は無改造で、その上に「採用(adopt)モデル」で乗る。
 */

const GOAL_DAYS = 30; // 30日固定（end_day = start_day + 29）。
export type GoalStatus = 'upcoming' | 'active' | 'completed';
export type GoalPracticeTarget = 'TOTAL_WORK' | 'GROUP' | 'PLANNING' | 'TIMELINE';
const TIME_TARGETS = new Set<GoalPracticeTarget>(['TOTAL_WORK', 'GROUP', 'TIMELINE']);

export class GoalNotFoundError extends Error {
  constructor(id: number) {
    super(`目標が見つかりません: ${id}`);
    this.name = 'GoalNotFoundError';
  }
}
export class GoalPracticeError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'GoalPracticeError';
  }
}
export class GoalDeleteWindowError extends Error {
  constructor() {
    super('目標を削除できるのは作成当日のみです');
    this.name = 'GoalDeleteWindowError';
  }
}
export class GoalReportNotReadyError extends Error {
  constructor() {
    super('レポートは完走（30日経過）後にのみ開けます');
    this.name = 'GoalReportNotReadyError';
  }
}
export class JournalNotWritableError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'JournalNotWritableError';
  }
}

interface GoalRow {
  id: number;
  name: string;
  purpose: string;
  start_day: string;
  end_day: string;
  created_at: number;
}
interface PracticeRow {
  goal_id: number;
  condition_key: string;
  target: GoalPracticeTarget;
  label_snapshot: string | null;
  stable_group_id: string | null;
  signal_key: string | null;
  sort_order: number;
}

// --- day_key 算術（UTC 計算で tz ずれ回避。util.js の addDays と同一規則）-----------
/** 'YYYY-MM-DD' に n 日加算。 */
export function addDaysKey(dayKey: string, n: number): string {
  const [y, m, d] = dayKey.split('-').map(Number);
  const dt = new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1));
  dt.setUTCDate(dt.getUTCDate() + n);
  const p = (x: number): string => String(x).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}
/** b - a の日数差（整数）。 */
function dayDiff(a: string, b: string): number {
  const toUtc = (k: string): number => {
    const [y, m, d] = k.split('-').map(Number);
    return Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1);
  };
  return Math.round((toUtc(b) - toUtc(a)) / 86_400_000);
}

function deriveStatus(today: string, startDay: string, endDay: string): GoalStatus {
  if (today < startDay) return 'upcoming';
  if (today > endDay) return 'completed';
  return 'active';
}

function getGoalRow(db: DB, id: number): GoalRow {
  const row = db.prepare('SELECT * FROM goal WHERE id = ?').get(id) as GoalRow | undefined;
  if (!row) throw new GoalNotFoundError(id);
  return row;
}

function practicesFor(db: DB, goalId: number): PracticeRow[] {
  return db
    .prepare('SELECT * FROM goal_practice WHERE goal_id = ? ORDER BY sort_order, condition_key')
    .all(goalId) as PracticeRow[];
}

// --- 採用候補 -------------------------------------------------------------

export interface AdoptCandidate {
  conditionKey: string;
  target: GoalPracticeTarget;
  label: string;
  stableGroupId: string | null;
  signalKey: string | null;
  thresholdSeconds: number | null;
}

/** 目標作成 UI 用: 開始日（＝翌日）の実効ルールから採用候補を出す。MANUAL_CHECK は除外（D1）。 */
export function adoptCandidates(db: DB, nowMs = Date.now()): AdoptCandidate[] {
  const startDay = nextDayKey(todayKey(db, nowMs));
  const eff = getEffectiveRuleSet(db, startDay, nowMs);
  if (!eff) return [];
  const groupNames = new Map(
    (db.prepare('SELECT stable_group_id, name FROM tab_group').all() as {
      stable_group_id: string;
      name: string;
    }[]).map((g) => [g.stable_group_id, g.name]),
  );
  const out: AdoptCandidate[] = [];
  for (const c of eff.conditions) {
    if (c.target === 'MANUAL_CHECK') continue; // 同一性が並び順依存のため採用不可。
    out.push({
      conditionKey: c.condition_key,
      target: c.target as GoalPracticeTarget,
      label: practiceLabel(c.target as GoalPracticeTarget, c, groupNames),
      stableGroupId: c.stable_group_id,
      signalKey: c.signal_key,
      thresholdSeconds: c.threshold_seconds,
    });
  }
  return out;
}

function practiceLabel(
  target: GoalPracticeTarget,
  c: { stable_group_id: string | null; signal_key: string | null; label: string | null; threshold_seconds: number | null },
  groupNames: Map<string, string>,
): string {
  if (target === 'TOTAL_WORK') return '総作業時間';
  if (target === 'GROUP')
    return `グループ: ${(c.stable_group_id && groupNames.get(c.stable_group_id)) || c.stable_group_id || '?'}`;
  if (target === 'PLANNING') return c.signal_key ?? '翌日計画';
  if (target === 'TIMELINE') {
    // 「<カテゴリ> ◯分以上」。timeline: 生キーは出さない。
    const min = c.threshold_seconds != null ? Math.round(c.threshold_seconds / 60) : 0;
    return `${c.label ?? 'カテゴリ'} ${min}分以上`;
  }
  return c.label ?? target;
}

// --- 作成 -----------------------------------------------------------------

export interface GoalView {
  id: number;
  name: string;
  purpose: string;
  startDay: string;
  endDay: string;
  createdAt: number;
  status: GoalStatus;
  /** 進行中のとき 1..30、それ以外 null。 */
  dayNumber: number | null;
  dayCount: number;
  canDelete: boolean;
  practices: {
    conditionKey: string;
    target: GoalPracticeTarget;
    label: string;
    stableGroupId: string | null;
    signalKey: string | null;
  }[];
}

function toView(db: DB, row: GoalRow, today: string): GoalView {
  const status = deriveStatus(today, row.start_day, row.end_day);
  return {
    id: row.id,
    name: row.name,
    purpose: row.purpose,
    startDay: row.start_day,
    endDay: row.end_day,
    createdAt: row.created_at,
    status,
    dayNumber: status === 'active' ? dayDiff(row.start_day, today) + 1 : null,
    dayCount: GOAL_DAYS,
    canDelete: dayKeyOf(db, row.created_at) === today,
    practices: practicesFor(db, row.id).map((p) => ({
      conditionKey: p.condition_key,
      target: p.target,
      label: p.label_snapshot ?? p.condition_key,
      stableGroupId: p.stable_group_id,
      signalKey: p.signal_key,
    })),
  };
}

function dayKeyOf(db: DB, ms: number): string {
  return todayKey(db, ms);
}

/** 目標作成時にその場で作成して採用する新規条件（初期対応は TIMELINE のみ・D3/D4）。 */
export interface NewInlineCondition {
  target: 'TIMELINE';
  label: string;
  thresholdSeconds: number;
}

export interface CreateGoalInput {
  name: string;
  purpose?: string;
  practices: string[]; // condition_key の配列
  newConditions?: NewInlineCondition[]; // その場で作成して採用する新規条件（翌日ルールへ追記・D3）。
}

/** 実効ルールの条件行を upsert 入力へ写す（materialize 用）。条件キー・閾値を据え置きで渡す。 */
function conditionRowToInput(c: RuleConditionRow): ConditionInput {
  return {
    target: c.target,
    stableGroupId: c.stable_group_id,
    comparator: (c.comparator as 'GTE') || 'GTE',
    thresholdSeconds: c.threshold_seconds,
    label: c.label,
    signalKey: c.signal_key,
    conditionKey: c.condition_key,
  };
}

/**
 * 目標を作成する。開始日は常に翌日、期間は30日固定。採用実践は翌日実効ルールから検証（D1/D3）。
 * `newConditions` があれば、翌日の実効ルールを materialize したうえで新規 TIMELINE 条件を追記し
 * （`upsertFutureRuleSet`）、その `condition_key` を採用リストへ合流させる。作成→採用は同一
 * トランザクションで、途中の失敗（凍結・ジャンル固定・採用不整合）は全体 rollback する。
 */
export function createGoal(db: DB, input: CreateGoalInput, nowMs = Date.now()): GoalView {
  const name = (input.name ?? '').trim();
  if (!name) throw new GoalPracticeError('目標名は必須です');

  // インライン新規条件のバリデーション（TIMELINE のみ・label 非空・thresholdSeconds > 0）。
  const newConditions = input.newConditions ?? [];
  for (const nc of newConditions) {
    if (nc.target !== 'TIMELINE')
      throw new GoalPracticeError('その場で作成できる条件はタイムライン記録（TIMELINE）のみです');
    if (!(nc.label ?? '').trim()) throw new GoalPracticeError('カテゴリ名を入力してください');
    if (!(typeof nc.thresholdSeconds === 'number' && nc.thresholdSeconds > 0))
      throw new GoalPracticeError('時間（分）は1分以上で指定してください');
  }

  const explicitKeys = input.practices ?? [];
  const inlineKeys = newConditions.map((nc) => `timeline:${nc.label.trim()}`);
  const keys = Array.from(new Set([...explicitKeys, ...inlineKeys]));
  if (keys.length === 0) throw new GoalPracticeError('実践を1つ以上採用してください');

  const today = todayKey(db, nowMs);
  const startDay = nextDayKey(today);
  const endDay = addDaysKey(startDay, GOAL_DAYS - 1);

  const tx = db.transaction(() => {
    // インライン条件があれば、翌日の実効ルールを materialize して新規 TIMELINE 条件を追記する。
    // 既存条件は condition_key・閾値を据え置きで渡すため、閾値変更理由要求もジャンル固定も発火しない。
    if (newConditions.length) {
      const eff = getEffectiveRuleSet(db, startDay, nowMs);
      const existing = (eff?.conditions ?? []).map(conditionRowToInput);
      const seen = new Set(
        existing.filter((c) => c.target === 'TIMELINE').map((c) => (c.label ?? '').trim()),
      );
      const appended: ConditionInput[] = [];
      for (const nc of newConditions) {
        const label = nc.label.trim();
        if (seen.has(label)) continue; // 既存/重複ラベルは追記せず既存キー採用へ寄せる。
        seen.add(label);
        appended.push({ target: 'TIMELINE', label, thresholdSeconds: nc.thresholdSeconds, comparator: 'GTE' });
      }
      upsertFutureRuleSet(
        db,
        startDay,
        { combinator: (eff?.ruleSet.combinator as 'ALL') || 'ALL', conditions: [...existing, ...appended] },
        nowMs,
      );
    }

    // 採用候補（翌日実効ルール・追記後）に照合し、スナップショットを取る。
    const candidates = new Map(adoptCandidates(db, nowMs).map((c) => [c.conditionKey, c]));
    const chosen = keys.map((k) => {
      const cand = candidates.get(k);
      if (!cand)
        throw new GoalPracticeError(`実践「${k}」は翌日の実効ルールに存在しません（採用できません）`);
      return cand;
    });

    const info = db
      .prepare(
        'INSERT INTO goal (name, purpose, start_day, end_day, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(name, (input.purpose ?? '').trim(), startDay, endDay, nowMs);
    const goalId = info.lastInsertRowid as number;
    const ins = db.prepare(
      `INSERT INTO goal_practice (goal_id, condition_key, target, label_snapshot, stable_group_id, signal_key, sort_order)
       VALUES (@goal, @key, @target, @label, @group, @signal, @sort)`,
    );
    chosen.forEach((c, i) =>
      ins.run({
        goal: goalId,
        key: c.conditionKey,
        target: c.target,
        label: c.label,
        group: c.stableGroupId,
        signal: c.signalKey,
        sort: i,
      }),
    );
    return goalId;
  });
  const goalId = tx();
  return toView(db, getGoalRow(db, goalId), today);
}

/** 目標一覧（導出 status 付き）。開始前・進行中・完走の順は日付降順。 */
export function listGoals(db: DB, nowMs = Date.now()): GoalView[] {
  const today = todayKey(db, nowMs);
  const rows = db
    .prepare('SELECT * FROM goal ORDER BY start_day DESC, id DESC')
    .all() as GoalRow[];
  return rows.map((r) => toView(db, r, today));
}

export function getGoal(db: DB, id: number, nowMs = Date.now()): GoalView {
  return toView(db, getGoalRow(db, id), todayKey(db, nowMs));
}

/** 作成当日限りの削除（誤作成の救済）。CASCADE で実践・日記も消える。 */
export function deleteGoal(db: DB, id: number, nowMs = Date.now()): boolean {
  const row = getGoalRow(db, id);
  const today = todayKey(db, nowMs);
  if (dayKeyOf(db, row.created_at) !== today) throw new GoalDeleteWindowError();
  return db.prepare('DELETE FROM goal WHERE id = ?').run(id).changes > 0;
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
  const status = deriveStatus(today, row.start_day, row.end_day);
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

// --- レポート集計（spec: goal-report / D5）--------------------------------

export interface ReportDayCell {
  dayKey: string;
  dayNumber: number;
  met: boolean;
  actualSeconds: number | null;
  thresholdSeconds: number | null;
}
export interface ReportPractice {
  conditionKey: string;
  target: GoalPracticeTarget;
  label: string;
  isTimeType: boolean;
  cells: ReportDayCell[];
}
export interface ReportThresholdChange {
  conditionKey: string;
  effectiveDate: string;
  dayNumber: number;
  oldSeconds: number | null;
  newSeconds: number | null;
  reason: string;
}
export interface ReportDayText {
  dayKey: string;
  dayNumber: number;
  text: string;
  source: 'journal' | 'reflection' | null;
}
export interface GoalReport {
  goal: {
    id: number;
    name: string;
    purpose: string;
    startDay: string;
    endDay: string;
    dayCount: number;
    achievedDays: number;
  };
  practices: ReportPractice[];
  hasTimeType: boolean;
  thresholdChanges: ReportThresholdChange[];
  days: ReportDayText[];
}

/** 完走した目標の完了レポートを集計する。完走前は GoalReportNotReadyError（API は 409）。 */
export function getGoalReport(db: DB, id: number, nowMs = Date.now()): GoalReport {
  const goal = getGoalRow(db, id);
  const today = todayKey(db, nowMs);
  if (deriveStatus(today, goal.start_day, goal.end_day) !== 'completed')
    throw new GoalReportNotReadyError();

  const practices = practicesFor(db, id);

  // 30日分の day_key を作り、評価行・日記・振り返りを一括ロードする。
  const dayKeys: string[] = [];
  for (let i = 0; i < GOAL_DAYS; i++) dayKeys.push(addDaysKey(goal.start_day, i));

  // 各日の per_condition_results（condition_key → 結果）。評価行が無い日は空。
  const evalByDay = new Map<string, Map<string, ConditionResult>>();
  for (const row of db
    .prepare(
      'SELECT day_key, per_condition_results FROM unlock_evaluation WHERE day_key BETWEEN ? AND ?',
    )
    .all(goal.start_day, goal.end_day) as { day_key: string; per_condition_results: string }[]) {
    const map = new Map<string, ConditionResult>();
    try {
      for (const r of JSON.parse(row.per_condition_results) as ConditionResult[])
        map.set(r.conditionKey, r);
    } catch {
      /* 壊れた JSON は空扱い（欠測＝未達成）。 */
    }
    evalByDay.set(row.day_key, map);
  }

  // ① 実践ごとの30日カレンダー（欠測・キー不在は未達成）。
  const reportPractices: ReportPractice[] = practices.map((p) => {
    const cells: ReportDayCell[] = dayKeys.map((dk, i) => {
      const entry = evalByDay.get(dk)?.get(p.condition_key);
      return {
        dayKey: dk,
        dayNumber: i + 1,
        met: entry?.met === true,
        actualSeconds: entry?.actualSeconds ?? null,
        thresholdSeconds: entry?.thresholdSeconds ?? null,
      };
    });
    return {
      conditionKey: p.condition_key,
      target: p.target,
      label: p.label_snapshot ?? p.condition_key,
      isTimeType: TIME_TARGETS.has(p.target),
      cells,
    };
  });

  // ヘッダ達成日数 = 全実践 met の日数。
  let achievedDays = 0;
  for (let i = 0; i < GOAL_DAYS; i++) {
    if (reportPractices.length > 0 && reportPractices.every((p) => p.cells[i]!.met)) achievedDays++;
  }

  // ② 閾値変更マーカー（採用実践キーのもの・期間内・理由つき）。
  const practiceKeys = practices.map((p) => p.condition_key);
  const thresholdChanges: ReportThresholdChange[] = practiceKeys.length
    ? (db
        .prepare(
          `SELECT condition_key, effective_date, old_seconds, new_seconds, reason
           FROM practice_threshold_change
           WHERE effective_date BETWEEN ? AND ?
             AND condition_key IN (${practiceKeys.map(() => '?').join(',')})
           ORDER BY effective_date`,
        )
        .all(goal.start_day, goal.end_day, ...practiceKeys) as {
        condition_key: string;
        effective_date: string;
        old_seconds: number | null;
        new_seconds: number | null;
        reason: string;
      }[]).map((r) => ({
        conditionKey: r.condition_key,
        effectiveDate: r.effective_date,
        dayNumber: dayDiff(goal.start_day, r.effective_date) + 1,
        oldSeconds: r.old_seconds,
        newSeconds: r.new_seconds,
        reason: r.reason,
      }))
    : [];

  // ③④ Day 別文面（goal_journal → reflection_entry の日単位フォールバック）。
  const journalByDay = new Map(
    (db.prepare('SELECT day_key, content FROM goal_journal WHERE goal_id = ?').all(id) as {
      day_key: string;
      content: string;
    }[]).map((r) => [r.day_key, r.content]),
  );
  const days: ReportDayText[] = dayKeys.map((dk, i) => {
    const j = journalByDay.get(dk);
    if (j && j.trim()) return { dayKey: dk, dayNumber: i + 1, text: j, source: 'journal' };
    const ref = getReflection(db, dk);
    if (ref && ref.content && ref.content.trim())
      return { dayKey: dk, dayNumber: i + 1, text: ref.content, source: 'reflection' };
    return { dayKey: dk, dayNumber: i + 1, text: '', source: null };
  });

  return {
    goal: {
      id: goal.id,
      name: goal.name,
      purpose: goal.purpose,
      startDay: goal.start_day,
      endDay: goal.end_day,
      dayCount: GOAL_DAYS,
      achievedDays,
    },
    practices: reportPractices,
    hasTimeType: reportPractices.some((p) => p.isTimeType),
    thresholdChanges,
    days,
  };
}
