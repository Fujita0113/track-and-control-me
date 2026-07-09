import type { DB } from '../db/index.js';

/** 日次振り返り（spec: reflection-and-planning / reflection-journal）。date ごとに1件。 */

export interface ReflectionRow {
  date: string;
  content: string;
  satisfaction: number | null; // 1..5, NULL=未評価
  created_at: number;
  updated_at: number;
}

export function getReflection(db: DB, date: string): ReflectionRow | null {
  return (db.prepare('SELECT * FROM reflection_entry WHERE date = ?').get(date) as
    | ReflectionRow
    | undefined) ?? null;
}

/** 満足度は 1..5 に丸め、範囲外/未指定は NULL。 */
function normalizeSatisfaction(v: unknown): number | null {
  if (v == null) return null;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < 1 || n > 5) return null;
  return n;
}

export function saveReflection(
  db: DB,
  date: string,
  content: string,
  satisfaction?: number | null,
): ReflectionRow {
  const now = Date.now();
  const sat = normalizeSatisfaction(satisfaction);
  db.prepare(
    `INSERT INTO reflection_entry (date, content, satisfaction, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(date) DO UPDATE SET
       content = excluded.content,
       satisfaction = excluded.satisfaction,
       updated_at = excluded.updated_at`,
  ).run(date, content, sat, now, now);
  return getReflection(db, date)!;
}

export interface ReflectionListItem {
  date: string;
  satisfaction: number | null;
  updated_at: number;
}

/** 保存済み振り返りの一覧（新しい日付順）。本文は含めない（一覧軽量化）。 */
export function listReflections(db: DB, limit = 180): ReflectionListItem[] {
  return db
    .prepare(
      `SELECT date, satisfaction, updated_at FROM reflection_entry
       ORDER BY date DESC LIMIT ?`,
    )
    .all(limit) as ReflectionListItem[];
}
