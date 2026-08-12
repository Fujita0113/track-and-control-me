import type { DB } from '../db/index.js';

/**
 * 家計簿の台帳（spec: kakeibo-ledger / kakeibo-gate・design.md D1-D4・D9-D12）。
 *
 * 支出レコードは日数を持たない。予想は「日々の出費 ÷ 経過日数 × 月の日数」の一本で出すため、
 * 名称ごとの周期・実績日数・カバー期間はここでは扱わない（design D2）。
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
  is_special: number;
  detail: string | null;
  bulk_from: string | null;
  bulk_to: string | null;
  receipt_id: number | null;
  created_at: number;
  updated_at: number;
}

export interface CreateEntryInput {
  dayKey: string;
  name: string;
  amountYen: number;
  category: string;
  importance: string;
  isSpecial?: boolean;
  detail?: string | null;
  receiptId?: number | null;
}

export interface UpdateEntryInput {
  amountYen?: number;
  name?: string;
  category?: string;
  importance?: string | null;
  isSpecial?: boolean;
  detail?: string | null;
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

/** 実効の特別費判定（design D3）。自動判定は保存しない＝カテゴリを直すと追随する。 */
export function isSpecialEntry(entry: KakeiboEntryRow): boolean {
  return entry.category === 'SUDDEN' || entry.is_special === 1;
}

export function createEntry(db: DB, input: CreateEntryInput): KakeiboEntryRow {
  validateAmount(input.amountYen);
  validateCategory(input.category);
  validateImportance(input.importance);

  const now = Date.now();
  const info = db
    .prepare(
      `INSERT INTO kakeibo_entry
        (day_key, name, amount_yen, category, importance, is_special, detail, bulk_from, bulk_to, receipt_id, created_at, updated_at)
       VALUES (@dayKey, @name, @amountYen, @category, @importance, @isSpecial, @detail, NULL, NULL, @receiptId, @now, @now)`,
    )
    .run({
      dayKey: input.dayKey,
      name: input.name,
      amountYen: input.amountYen,
      category: input.category,
      importance: input.importance,
      isSpecial: input.isSpecial ? 1 : 0,
      detail: input.detail ?? null,
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
  if (patch.amountYen !== undefined) {
    sets.push('amount_yen = @amountYen');
    params.amountYen = patch.amountYen;
  }
  if (patch.name !== undefined) {
    sets.push('name = @name');
    params.name = patch.name;
  }
  if (patch.category !== undefined) {
    sets.push('category = @category');
    params.category = patch.category;
  }
  if (patch.importance !== undefined) {
    sets.push('importance = @importance');
    params.importance = patch.importance;
  }
  if (patch.isSpecial !== undefined) {
    sets.push('is_special = @isSpecial');
    params.isSpecial = patch.isSpecial ? 1 : 0;
  }
  if (patch.detail !== undefined) {
    sets.push('detail = @detail');
    params.detail = patch.detail;
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

export function createBulkEntry(db: DB, input: CreateBulkEntryInput): KakeiboEntryRow {
  if (input.toDayKey < input.fromDayKey) throw new KakeiboError('期間が逆転しています');
  validateAmount(input.amountYen);
  const now = Date.now();
  const info = db
    .prepare(
      `INSERT INTO kakeibo_entry
        (day_key, name, amount_yen, category, importance, is_special, detail, bulk_from, bulk_to, receipt_id, created_at, updated_at)
       VALUES (@dayKey, '', @amountYen, 'NONE', NULL, 0, NULL, @fromDayKey, @toDayKey, NULL, @now, @now)`,
    )
    .run({ dayKey: input.fromDayKey, amountYen: input.amountYen, fromDayKey: input.fromDayKey, toDayKey: input.toDayKey, now });
  return getEntryById(db, Number(info.lastInsertRowid))!;
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
