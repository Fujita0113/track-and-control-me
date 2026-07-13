import type { DB } from '../db/index.js';
import { nextDayKey } from '../aggregation/index.js';
import {
  getEffectiveRuleSet,
  upsertFutureRuleSet,
  effectiveTimeThresholds,
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
/** 目標の開始日選択（既定=今日）。今日開始は当日を Day1 として即「進行中」（spec: goal-challenge / D3）。 */
export type GoalStart = 'today' | 'tomorrow';
export type GoalPracticeTarget = 'TOTAL_WORK' | 'GROUP' | 'PLANNING' | 'TIMELINE' | 'MANUAL_CHECK';
// 時間型（②時間推移の対象・isTimeType=true）。MANUAL_CHECK / PLANNING は非時間型。
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

/** 開始日選択（today|tomorrow）から start_day を算出する。既定は今日（D3）。 */
export function goalStartDay(db: DB, nowMs: number, start: GoalStart): string {
  const today = todayKey(db, nowMs);
  return start === 'tomorrow' ? nextDayKey(today) : today;
}

/**
 * 目標作成 UI 用: 開始日（今日開始なら当日・明日開始なら翌日）の実効ルールから採用候補を出す。
 * 安定キーを持つ全ターゲット（TOTAL_WORK / GROUP / PLANNING / TIMELINE / MANUAL_CHECK）が候補になる。
 * MANUAL_CHECK は manual:<ラベル> の安定キー（manual-check-stable-key）導入で採用可能になった。
 * 今日開始では当日実効ルール（当日追加を含む）が候補元になる。
 */
export function adoptCandidates(db: DB, nowMs = Date.now(), start: GoalStart = 'today'): AdoptCandidate[] {
  const startDay = goalStartDay(db, nowMs, start);
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
  // MANUAL_CHECK は非時間型。チェックのテキスト（ラベル）を接頭辞なしでそのまま表示する。
  if (target === 'MANUAL_CHECK') return c.label ?? '手動チェック';
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
    /**
     * 時間条件の当日実効閾値秒（timeline-tracked-highlight の強調バッジ用・D5）。
     * 目標の実効日（active=当日 / upcoming=開始日）のルールで解決。非時間条件・未解決は null。
     */
    thresholdSeconds: number | null;
  }[];
}

function toView(db: DB, row: GoalRow, today: string, nowMs: number): GoalView {
  const status = deriveStatus(today, row.start_day, row.end_day);
  // 閾値バッジ用: 目標が効く日（進行中は当日、開始前は開始日）の実効ルールから閾値を解決する。
  const effDate = today < row.start_day ? row.start_day : today;
  const thresholds = effectiveTimeThresholds(db, effDate, nowMs);
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
      thresholdSeconds: thresholds.get(p.condition_key) ?? null,
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
  newConditions?: NewInlineCondition[]; // その場で作成して採用する新規条件（開始日ルールへ追記・D3/D4）。
  start?: GoalStart; // 開始日の選択（today|tomorrow）。既定=today。
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
 * 目標を作成する。開始日は今日／明日の選択式（既定=今日）、期間は30日固定。
 * 採用実践は開始日の実効ルール（今日開始なら当日実効ルール＝当日追加を含む）から検証（D1/D3）。
 * `newConditions` があれば、開始日の実効ルールを materialize したうえで新規 TIMELINE 条件を追記し
 * （今日開始は当日 DRAFT_TODAY 経路・明日開始は翌日ルール）、その `condition_key` を採用リストへ合流させる。
 * 作成→採用は同一トランザクションで、途中の失敗（凍結・ジャンル固定・採用不整合）は全体 rollback する。
 */
export function createGoal(db: DB, input: CreateGoalInput, nowMs = Date.now()): GoalView {
  const name = (input.name ?? '').trim();
  if (!name) throw new GoalPracticeError('目標名は必須です');
  const start: GoalStart = input.start === 'tomorrow' ? 'tomorrow' : 'today';

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
  const startDay = goalStartDay(db, nowMs, start);
  const endDay = addDaysKey(startDay, GOAL_DAYS - 1);

  const tx = db.transaction(() => {
    // インライン条件があれば、開始日（今日開始=当日 / 明日開始=翌日）の実効ルールを materialize して
    // 新規 TIMELINE 条件を追記する。今日開始は当日 add-only 経路（DRAFT_TODAY・baseline 保存）になる。
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

    // 採用候補（開始日の実効ルール・追記後）に照合し、スナップショットを取る。
    const candidates = new Map(adoptCandidates(db, nowMs, start).map((c) => [c.conditionKey, c]));
    const chosen = keys.map((k) => {
      const cand = candidates.get(k);
      if (!cand)
        throw new GoalPracticeError(`実践「${k}」は開始日の実効ルールに存在しません（採用できません）`);
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
  return toView(db, getGoalRow(db, goalId), today, nowMs);
}

/** 目標一覧（導出 status 付き）。開始前・進行中・完走の順は日付降順。 */
export function listGoals(db: DB, nowMs = Date.now()): GoalView[] {
  const today = todayKey(db, nowMs);
  const rows = db
    .prepare('SELECT * FROM goal ORDER BY start_day DESC, id DESC')
    .all() as GoalRow[];
  return rows.map((r) => toView(db, r, today, nowMs));
}

export function getGoal(db: DB, id: number, nowMs = Date.now()): GoalView {
  return toView(db, getGoalRow(db, id), todayKey(db, nowMs), nowMs);
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
    dayCount: number;
    achievedDays: number;
  };
  practices: ReportPractice[];
  hasTimeType: boolean;
  thresholdChanges: ReportThresholdChange[];
  days: ReportDayText[];
  /** 全画像の平坦リスト（(caption, dayNumber, sortOrder) 昇順）。③の2モードが使う（D5）。 */
  reportImages: ReportImage[];
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
  // 各日の画像メタ（④用・sort_order 昇順）＋ ③用の平坦リスト。バイトは含めない（JSON は軽いまま・D5）。
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
  // (caption, dayNumber, sortOrder) 昇順に並べ替える（③の2モードが前提とする決定的な並び）。
  reportImages.sort(
    (a, b) =>
      a.caption.trim().localeCompare(b.caption.trim()) ||
      a.dayNumber - b.dayNumber ||
      a.sortOrder - b.sortOrder,
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
    reportImages,
  };
}
