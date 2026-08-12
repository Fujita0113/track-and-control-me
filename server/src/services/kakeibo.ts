import type { DB } from '../db/index.js';
import { addDaysKey, dayDiff } from './day-key.js';
import { todayKey } from './summary.js';

/**
 * 家計簿の台帳と「日数の在庫」（spec: kakeibo-ledger / kakeibo-day-rate / kakeibo-gate・design.md D1-D4・D10-D11）。
 *
 * 期待値は ref/kakeibo/kakeibo-mock.html の筋書き（2026-08-11 時点）を凍結したもの
 * （design.md「数字の筋書き」・kakeibo.test.ts）。
 */

export class KakeiboError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'KakeiboError';
  }
}

const CATEGORIES = new Set(['FOOD', 'DAILY', 'FUN', 'SUDDEN', 'NONE']);
const IMPORTANCES = new Set(['MUST', 'SEMI', 'WASTE']);

function validateAmount(amountYen: number): void {
  if (!Number.isInteger(amountYen) || amountYen <= 0) {
    throw new KakeiboError('金額は正の整数円で入力してください');
  }
}
function validateCategory(category: string): void {
  if (!CATEGORIES.has(category)) throw new KakeiboError(`未知のカテゴリです: ${category}`);
}
function validateImportance(importance: string): void {
  if (!IMPORTANCES.has(importance)) throw new KakeiboError(`未知の重要度です: ${importance}`);
}

export interface KakeiboEntryRow {
  id: number;
  day_key: string;
  name: string;
  amount_yen: number;
  category: string;
  importance: string | null;
  planned_days: number;
  actual_days: number | null;
  covers_from: string;
  bulk_from: string | null;
  bulk_to: string | null;
  receipt_id: number | null;
  created_at: number;
  updated_at: number;
}

export type KakeiboConfirmChoiceKind = 'REMAINING' | 'TODAY' | 'EARLIER';
export interface KakeiboConfirmChoice {
  choice: KakeiboConfirmChoiceKind;
  n?: number;
}

export interface CreateEntryInput {
  dayKey: string;
  name: string;
  amountYen: number;
  category: string;
  importance: string;
  plannedDays?: number;
  receiptId?: number | null;
  /** 同名の前回の未確定レコードをこの回答で確定してから記録する（design D3）。 */
  confirm?: KakeiboConfirmChoice;
}

export interface UpdateEntryInput {
  plannedDays?: number;
  actualDays?: number | null;
  amountYen?: number;
  category?: string;
  importance?: string | null;
  receiptId?: number | null;
}

export interface CreateBulkEntryInput {
  fromDayKey: string;
  toDayKey: string;
  amountYen: number;
}

function getEntryById(db: DB, id: number): KakeiboEntryRow | undefined {
  return db.prepare('SELECT * FROM kakeibo_entry WHERE id = ?').get(id) as KakeiboEntryRow | undefined;
}

/** 支出レコードの3状態（design D4）。実績あり=確定／進行中=暫定／予定超過かつ未入力=未確定。 */
export function entryState(entry: KakeiboEntryRow, todayDayKey: string): 'CONFIRMED' | 'PROVISIONAL' | 'PENDING' {
  if (entry.actual_days != null) return 'CONFIRMED';
  const overDate = addDaysKey(entry.covers_from, entry.planned_days);
  return todayDayKey >= overDate ? 'PENDING' : 'PROVISIONAL';
}

export function createEntry(db: DB, input: CreateEntryInput): KakeiboEntryRow {
  validateAmount(input.amountYen);
  validateCategory(input.category);
  validateImportance(input.importance);
  const plannedDays = input.plannedDays ?? 1;

  let coversFrom = input.dayKey;
  if (input.confirm) {
    const pending = pendingConfirmation(db, input.name, input.dayKey);
    if (pending) {
      const confirmedPrev = confirmActualDays(db, pending.entryId, input.confirm, input.dayKey);
      coversFrom =
        input.confirm.choice === 'REMAINING'
          ? addDaysKey(confirmedPrev.covers_from, confirmedPrev.actual_days! - 1)
          : input.dayKey;
    }
  }

  const now = Date.now();
  const info = db
    .prepare(
      `INSERT INTO kakeibo_entry
        (day_key, name, amount_yen, category, importance, planned_days, actual_days, covers_from, bulk_from, bulk_to, receipt_id, created_at, updated_at)
       VALUES (@dayKey, @name, @amountYen, @category, @importance, @plannedDays, NULL, @coversFrom, NULL, NULL, @receiptId, @now, @now)`,
    )
    .run({
      dayKey: input.dayKey,
      name: input.name,
      amountYen: input.amountYen,
      category: input.category,
      importance: input.importance,
      plannedDays,
      coversFrom,
      receiptId: input.receiptId ?? null,
      now,
    });
  return getEntryById(db, Number(info.lastInsertRowid))!;
}

export function updateEntry(db: DB, id: number, patch: UpdateEntryInput): KakeiboEntryRow {
  const entry = getEntryById(db, id);
  if (!entry) throw new KakeiboError('支出レコードが見つかりません');
  if (patch.amountYen !== undefined) validateAmount(patch.amountYen);
  if (patch.category !== undefined) validateCategory(patch.category);
  if (patch.importance !== undefined && patch.importance !== null) validateImportance(patch.importance);

  const sets: string[] = [];
  const params: Record<string, unknown> = { id, now: Date.now() };
  if (patch.plannedDays !== undefined) {
    sets.push('planned_days = @plannedDays');
    params.plannedDays = patch.plannedDays;
  }
  if (patch.actualDays !== undefined) {
    sets.push('actual_days = @actualDays');
    params.actualDays = patch.actualDays;
  }
  if (patch.amountYen !== undefined) {
    sets.push('amount_yen = @amountYen');
    params.amountYen = patch.amountYen;
  }
  if (patch.category !== undefined) {
    sets.push('category = @category');
    params.category = patch.category;
  }
  if (patch.importance !== undefined) {
    sets.push('importance = @importance');
    params.importance = patch.importance;
  }
  if (patch.receiptId !== undefined) {
    sets.push('receipt_id = @receiptId');
    params.receiptId = patch.receiptId;
  }
  if (sets.length > 0) {
    db.prepare(`UPDATE kakeibo_entry SET ${sets.join(', ')}, updated_at = @now WHERE id = @id`).run(params);
  }
  return getEntryById(db, id)!;
}

export function listEntries(db: DB, monthKey: string): KakeiboEntryRow[] {
  return db
    .prepare('SELECT * FROM kakeibo_entry WHERE day_key LIKE ? ORDER BY day_key DESC, id DESC')
    .all(`${monthKey}%`) as KakeiboEntryRow[];
}

export function suggestNames(db: DB, prefix: string): string[] {
  const rows = db
    .prepare(
      `SELECT name, MAX(day_key) AS last_day, MAX(id) AS last_id
       FROM kakeibo_entry
       WHERE name <> '' AND name LIKE @pattern
       GROUP BY name
       ORDER BY last_day DESC, last_id DESC`,
    )
    .all({ pattern: `%${prefix}%` }) as { name: string }[];
  return rows.map((r) => r.name);
}

export interface PendingConfirmationChoice {
  choice: KakeiboConfirmChoiceKind;
  actualDays: number;
  ratePerDay: number | null;
}
export interface PendingConfirmation {
  entryId: number;
  name: string;
  amountYen: number;
  coversFrom: string;
  elapsedDays: number;
  defaultChoice: KakeiboConfirmChoiceKind;
  choices: PendingConfirmationChoice[];
}

/** 在庫ものの記録時に前回の未確定レコードと3択を返す（PENDING のときだけ・design D3）。 */
export function pendingConfirmation(db: DB, name: string, dayKey: string): PendingConfirmation | null {
  if (!name) return null;
  const prev = db
    .prepare(
      `SELECT * FROM kakeibo_entry
       WHERE name = @name AND actual_days IS NULL AND planned_days >= 2
       ORDER BY day_key DESC, id DESC LIMIT 1`,
    )
    .get({ name }) as KakeiboEntryRow | undefined;
  if (!prev) return null;
  if (entryState(prev, dayKey) !== 'PENDING') return null;

  const elapsed = dayDiff(prev.covers_from, dayKey) + 1;
  const rateFor = (actualDays: number): number | null =>
    actualDays > 0 ? Math.floor(prev.amount_yen / actualDays) : null;

  const choices: PendingConfirmationChoice[] = [
    { choice: 'REMAINING', actualDays: elapsed + 1, ratePerDay: rateFor(elapsed + 1) },
    { choice: 'TODAY', actualDays: elapsed, ratePerDay: rateFor(elapsed) },
    { choice: 'EARLIER', actualDays: elapsed - 1, ratePerDay: rateFor(elapsed - 1) },
  ];
  return {
    entryId: prev.id,
    name: prev.name,
    amountYen: prev.amount_yen,
    coversFrom: prev.covers_from,
    elapsedDays: elapsed,
    defaultChoice: 'TODAY',
    choices,
  };
}

/** 実績日数を確定する（design D3）。`REMAINING` は `covers_from` を前回が切れた翌日へずらす側の計算は呼び出し側が担う。 */
export function confirmActualDays(
  db: DB,
  id: number,
  choice: KakeiboConfirmChoice,
  asOfDayKey?: string,
): KakeiboEntryRow {
  const entry = getEntryById(db, id);
  if (!entry) throw new KakeiboError('支出レコードが見つかりません');
  const today = asOfDayKey ?? todayKey(db);
  const elapsed = dayDiff(entry.covers_from, today) + 1;
  const n = choice.n ?? 1;

  let actualDays: number;
  switch (choice.choice) {
    case 'REMAINING':
      actualDays = elapsed + n;
      break;
    case 'TODAY':
      actualDays = elapsed;
      break;
    case 'EARLIER':
      actualDays = elapsed - n;
      break;
  }
  if (actualDays <= 0) throw new KakeiboError('実績日数は1日以上にしてください');

  db.prepare('UPDATE kakeibo_entry SET actual_days = ?, updated_at = ? WHERE id = ?').run(actualDays, Date.now(), id);
  return getEntryById(db, id)!;
}

export function createBulkEntry(db: DB, input: CreateBulkEntryInput): KakeiboEntryRow {
  if (input.toDayKey < input.fromDayKey) throw new KakeiboError('期間が逆転しています');
  validateAmount(input.amountYen);
  const days = dayDiff(input.fromDayKey, input.toDayKey) + 1;
  const now = Date.now();
  const info = db
    .prepare(
      `INSERT INTO kakeibo_entry
        (day_key, name, amount_yen, category, importance, planned_days, actual_days, covers_from, bulk_from, bulk_to, receipt_id, created_at, updated_at)
       VALUES (@dayKey, '', @amountYen, 'NONE', NULL, @days, @days, @dayKey, @dayKey, @toDayKey, NULL, @now, @now)`,
    )
    .run({ dayKey: input.fromDayKey, amountYen: input.amountYen, days, toDayKey: input.toDayKey, now });
  return getEntryById(db, Number(info.lastInsertRowid))!;
}

export interface CoverageSpan {
  entryId: number;
  fromDayKey: string;
  toDayKey: string;
  ghostToDayKey: string | null;
  ghostKind: 'SHORT' | 'OVER' | null;
  lane: 'STOCK' | 'BULK';
  category: string;
  name: string;
  amountYen: number;
}
export interface CoverageDot {
  entryId: number;
  dayKey: string;
  category: string;
}
export interface MonthCoverage {
  spans: CoverageSpan[];
  dots: CoverageDot[];
}

/** 支出のカバー期間の帯（design D3・spec: kakeibo-day-rate）。 */
export function monthCoverage(db: DB, monthKey: string, todayDayKey: string): MonthCoverage {
  const rows = listEntries(db, monthKey);
  const spans: CoverageSpan[] = [];
  const dots: CoverageDot[] = [];

  for (const r of rows) {
    if (r.bulk_from) {
      spans.push({
        entryId: r.id,
        fromDayKey: r.bulk_from,
        toDayKey: r.bulk_to!,
        ghostToDayKey: null,
        ghostKind: null,
        lane: 'BULK',
        category: r.category,
        name: r.name,
        amountYen: r.amount_yen,
      });
      continue;
    }
    if (r.planned_days <= 1) {
      dots.push({ entryId: r.id, dayKey: r.day_key, category: r.category });
      continue;
    }

    const plannedEnd = addDaysKey(r.covers_from, r.planned_days - 1);
    if (r.actual_days != null) {
      const filledEnd = addDaysKey(r.covers_from, r.actual_days - 1);
      const short = r.actual_days < r.planned_days;
      spans.push({
        entryId: r.id,
        fromDayKey: r.covers_from,
        toDayKey: filledEnd,
        ghostToDayKey: short ? plannedEnd : null,
        ghostKind: short ? 'SHORT' : null,
        lane: 'STOCK',
        category: r.category,
        name: r.name,
        amountYen: r.amount_yen,
      });
    } else if (todayDayKey >= addDaysKey(plannedEnd, 1)) {
      spans.push({
        entryId: r.id,
        fromDayKey: r.covers_from,
        toDayKey: plannedEnd,
        ghostToDayKey: todayDayKey,
        ghostKind: 'OVER',
        lane: 'STOCK',
        category: r.category,
        name: r.name,
        amountYen: r.amount_yen,
      });
    } else {
      const filledEnd = todayDayKey < plannedEnd ? todayDayKey : plannedEnd;
      spans.push({
        entryId: r.id,
        fromDayKey: r.covers_from,
        toDayKey: filledEnd,
        ghostToDayKey: null,
        ghostKind: null,
        lane: 'STOCK',
        category: r.category,
        name: r.name,
        amountYen: r.amount_yen,
      });
    }
  }

  return { spans, dots };
}

/** 解錠ゲートのシグナル（design D11・spec: kakeibo-gate）。 */
export function isKakeiboRecorded(db: DB, dayKey: string): boolean {
  const r = db.prepare('SELECT 1 FROM kakeibo_entry WHERE day_key = ? LIMIT 1').get(dayKey);
  if (r) return true;
  const z = db.prepare('SELECT 1 FROM kakeibo_zero_day WHERE day_key = ? LIMIT 1').get(dayKey);
  return !!z;
}

export function declareZeroDay(db: DB, dayKey: string): void {
  db.prepare('INSERT OR IGNORE INTO kakeibo_zero_day (day_key, created_at) VALUES (?, ?)').run(dayKey, Date.now());
}

// --- レシート（design D12。goal_journal_image は再利用しない） ------------

const RECEIPT_MIME_ALLOW = new Set(['image/jpeg', 'image/png', 'image/webp']);
const RECEIPT_MAX_BYTES = 5 * 1024 * 1024;

/** data URL（`data:<mime>;base64,<payload>`）を mime とバイト列へ分解する。 */
function parseDataUrl(dataUrl: string): { mime: string; bytes: Buffer } {
  const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(String(dataUrl ?? ''));
  if (!m) throw new KakeiboError('画像データが不正です');
  const mime = m[1]!.toLowerCase();
  const bytes = m[2] ? Buffer.from(m[3]!, 'base64') : Buffer.from(decodeURIComponent(m[3]!));
  return { mime, bytes };
}

export interface CreateReceiptInput {
  dataUrl: string;
  width?: number | null;
  height?: number | null;
}

export function createReceipt(db: DB, input: CreateReceiptInput): { id: number } {
  const { mime, bytes } = parseDataUrl(input.dataUrl);
  if (!RECEIPT_MIME_ALLOW.has(mime)) throw new KakeiboError('対応していない画像形式です（JPEG / PNG / WebP のみ）');
  if (bytes.length === 0) throw new KakeiboError('画像データが空です');
  if (bytes.length > RECEIPT_MAX_BYTES) throw new KakeiboError('画像サイズが上限（5MB）を超えています');
  const info = db
    .prepare('INSERT INTO kakeibo_receipt (mime, bytes, width, height, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(mime, bytes, input.width ?? null, input.height ?? null, Date.now());
  return { id: Number(info.lastInsertRowid) };
}

export function getReceiptBytes(db: DB, id: number): { mime: string; bytes: Buffer } | undefined {
  return db.prepare('SELECT mime, bytes FROM kakeibo_receipt WHERE id = ?').get(id) as
    | { mime: string; bytes: Buffer }
    | undefined;
}
