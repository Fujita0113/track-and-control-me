import type { DB } from '../db/index.js';

/**
 * MANUAL_CHECK 条件の当日チェック状態（task 4.7 / spec: MVP 手動チェック）。
 */

export function getCheck(db: DB, dayKey: string, conditionKey: string): boolean {
  const r = db
    .prepare('SELECT checked FROM daily_check WHERE day_key = ? AND condition_key = ?')
    .get(dayKey, conditionKey) as { checked: number } | undefined;
  return r ? r.checked === 1 : false;
}

export function setCheck(
  db: DB,
  dayKey: string,
  conditionKey: string,
  checked: boolean,
  nowMs = Date.now(),
): void {
  db.prepare(
    `INSERT INTO daily_check (day_key, condition_key, checked, checked_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(day_key, condition_key)
       DO UPDATE SET checked = excluded.checked, checked_at = excluded.checked_at`,
  ).run(dayKey, conditionKey, checked ? 1 : 0, checked ? nowMs : null);
}

export function listChecks(db: DB, dayKey: string): { conditionKey: string; checked: boolean }[] {
  const rows = db
    .prepare('SELECT condition_key, checked FROM daily_check WHERE day_key = ?')
    .all(dayKey) as { condition_key: string; checked: number }[];
  return rows.map((r) => ({ conditionKey: r.condition_key, checked: r.checked === 1 }));
}
