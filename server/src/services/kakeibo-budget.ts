import type { DB } from '../db/index.js';
import { addDaysKey } from './day-key.js';
import { createEntry, type KakeiboEntryRow } from './kakeibo.js';
import { floor10, prevMonthKey, daysInMonth } from './kakeibo-shared.js';

/**
 * 予算（spec: kakeibo-budget・design D7・D8・D9）。
 * 上限 − 固定費 = 変動費に使える → floor10 の週の目標（保存せず導出）。
 */

export class KakeiboBudgetError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'KakeiboBudgetError';
  }
}

export interface KakeiboBudgetRow {
  month_key: string;
  cap_yen: number;
  waste_cap_yen: number;
  updated_at: number;
}

export interface SetBudgetInput {
  capYen?: number;
  wasteCapYen?: number;
}

export function getBudget(db: DB, monthKey: string): KakeiboBudgetRow {
  const row = db.prepare('SELECT * FROM kakeibo_budget WHERE month_key = ?').get(monthKey) as
    | KakeiboBudgetRow
    | undefined;
  return row ?? { month_key: monthKey, cap_yen: 0, waste_cap_yen: 0, updated_at: 0 };
}

export function setBudget(db: DB, monthKey: string, patch: SetBudgetInput): KakeiboBudgetRow {
  const current = getBudget(db, monthKey);
  const capYen = patch.capYen ?? current.cap_yen;
  const wasteCapYen = patch.wasteCapYen ?? current.waste_cap_yen;
  if (capYen < 0 || wasteCapYen < 0) throw new KakeiboBudgetError('上限に負の値は入れられません');

  const now = Date.now();
  db.prepare(
    `INSERT INTO kakeibo_budget (month_key, cap_yen, waste_cap_yen, updated_at)
     VALUES (@monthKey, @capYen, @wasteCapYen, @now)
     ON CONFLICT(month_key) DO UPDATE SET cap_yen = @capYen, waste_cap_yen = @wasteCapYen, updated_at = @now`,
  ).run({ monthKey, capYen, wasteCapYen, now });
  return getBudget(db, monthKey);
}

export interface KakeiboFixedCostRow {
  id: number;
  month_key: string;
  name: string;
  amount_yen: number;
  sort_order: number;
  prev_amount_yen: number | null;
}

export function listFixedCosts(db: DB, monthKey: string): KakeiboFixedCostRow[] {
  const rows = db
    .prepare('SELECT * FROM kakeibo_fixed_cost WHERE month_key = ? ORDER BY sort_order, id')
    .all(monthKey) as Omit<KakeiboFixedCostRow, 'prev_amount_yen'>[];
  const prev = prevMonthKey(monthKey);
  const prevRows = db.prepare('SELECT name, amount_yen FROM kakeibo_fixed_cost WHERE month_key = ?').all(prev) as {
    name: string;
    amount_yen: number;
  }[];
  const prevByName = new Map(prevRows.map((r) => [r.name, r.amount_yen]));
  return rows.map((r) => ({ ...r, prev_amount_yen: prevByName.get(r.name) ?? null }));
}

export interface FixedCostInput {
  name: string;
  amountYen: number;
}

export function upsertFixedCost(db: DB, monthKey: string, input: FixedCostInput): void {
  db.prepare(
    `INSERT INTO kakeibo_fixed_cost (month_key, name, amount_yen, sort_order)
     VALUES (@monthKey, @name, @amountYen, 0)
     ON CONFLICT(month_key, name) DO UPDATE SET amount_yen = @amountYen`,
  ).run({ monthKey, name: input.name, amountYen: input.amountYen });
}

export function deleteFixedCost(db: DB, id: number): void {
  db.prepare('DELETE FROM kakeibo_fixed_cost WHERE id = ?').run(id);
}

export function updateFixedCost(db: DB, id: number, patch: { name?: string; amountYen?: number }): void {
  const sets: string[] = [];
  const params: Record<string, unknown> = { id };
  if (patch.name !== undefined) {
    sets.push('name = @name');
    params.name = patch.name;
  }
  if (patch.amountYen !== undefined) {
    sets.push('amount_yen = @amountYen');
    params.amountYen = patch.amountYen;
  }
  if (sets.length > 0) {
    db.prepare(`UPDATE kakeibo_fixed_cost SET ${sets.join(', ')} WHERE id = @id`).run(params);
  }
}

/** 前月の固定費の行を名称と金額ごと複製する。既存名称は上書きしない（design D8）。 */
export function importFixedCostsFromPrevMonth(db: DB, monthKey: string): void {
  const prev = prevMonthKey(monthKey);
  const prevRows = db.prepare('SELECT name, amount_yen, sort_order FROM kakeibo_fixed_cost WHERE month_key = ?').all(
    prev,
  ) as { name: string; amount_yen: number; sort_order: number }[];
  const existingNames = new Set(
    (db.prepare('SELECT name FROM kakeibo_fixed_cost WHERE month_key = ?').all(monthKey) as { name: string }[]).map(
      (r) => r.name,
    ),
  );
  const insert = db.prepare(
    'INSERT INTO kakeibo_fixed_cost (month_key, name, amount_yen, sort_order) VALUES (?, ?, ?, ?)',
  );
  for (const r of prevRows) {
    if (existingNames.has(r.name)) continue;
    insert.run(monthKey, r.name, r.amount_yen, r.sort_order);
  }
}

export interface BudgetDerived {
  fixedTotalYen: number;
  variableYen: number;
  daysInMonth: number;
  weeklyTargetYen: number;
}

/** 変動費に使える額と週の目標を導出する（保存しない・design D8）。 */
export function budgetDerived(db: DB, monthKey: string): BudgetDerived {
  const budget = getBudget(db, monthKey);
  const fixedTotalYen = listFixedCosts(db, monthKey).reduce((a, r) => a + r.amount_yen, 0);
  const variableYen = budget.cap_yen - fixedTotalYen;
  const days = daysInMonth(monthKey);
  const weeklyTargetYen = floor10((variableYen / days) * 7);
  return { fixedTotalYen, variableYen, daysInMonth: days, weeklyTargetYen };
}

export interface KakeiboPlannedExpenseRow {
  id: number;
  name: string;
  category: string;
  cycle_days: number;
  next_day_key: string;
  amount_yen: number;
  sort_order: number;
  created_at: number;
}

export interface PlannedExpenseInput {
  name: string;
  category: string;
  cycleDays: number;
  nextDayKey: string;
  amountYen: number;
}

export function listPlannedExpenses(
  db: DB,
  opts?: { monthKey?: string; fromDayKey?: string },
): KakeiboPlannedExpenseRow[] {
  let rows = db.prepare('SELECT * FROM kakeibo_planned_expense ORDER BY sort_order, id').all() as KakeiboPlannedExpenseRow[];
  if (opts?.monthKey) {
    rows = rows.filter((r) => r.next_day_key.startsWith(opts.monthKey!));
  }
  if (opts?.fromDayKey) {
    rows = rows.filter((r) => r.next_day_key >= opts.fromDayKey!);
  }
  return rows;
}

export function upsertPlannedExpense(db: DB, input: PlannedExpenseInput & { id?: number }): KakeiboPlannedExpenseRow {
  if (input.cycleDays <= 0) throw new KakeiboBudgetError('周期は1日以上にしてください');
  if (input.id != null) {
    db.prepare(
      `UPDATE kakeibo_planned_expense
       SET name = @name, category = @category, cycle_days = @cycleDays, next_day_key = @nextDayKey, amount_yen = @amountYen
       WHERE id = @id`,
    ).run({ ...input, id: input.id });
    return db.prepare('SELECT * FROM kakeibo_planned_expense WHERE id = ?').get(input.id) as KakeiboPlannedExpenseRow;
  }
  const info = db
    .prepare(
      `INSERT INTO kakeibo_planned_expense (name, category, cycle_days, next_day_key, amount_yen, sort_order, created_at)
       VALUES (@name, @category, @cycleDays, @nextDayKey, @amountYen, 0, @now)`,
    )
    .run({ ...input, now: Date.now() });
  return db
    .prepare('SELECT * FROM kakeibo_planned_expense WHERE id = ?')
    .get(Number(info.lastInsertRowid)) as KakeiboPlannedExpenseRow;
}

export function deletePlannedExpense(db: DB, id: number): void {
  db.prepare('DELETE FROM kakeibo_planned_expense WHERE id = ?').run(id);
}

export interface RecordPlannedExpenseInput {
  dayKey: string;
  amountYen: number;
  importance: string;
}

/** チップから記録すると実績が1件でき、次回が周期ぶん進む（design D9）。 */
export function recordPlannedExpense(db: DB, id: number, input: RecordPlannedExpenseInput): KakeiboEntryRow {
  const p = db.prepare('SELECT * FROM kakeibo_planned_expense WHERE id = ?').get(id) as
    | KakeiboPlannedExpenseRow
    | undefined;
  if (!p) throw new KakeiboBudgetError('予定出費が見つかりません');

  const entry = createEntry(db, {
    dayKey: input.dayKey,
    name: p.name,
    amountYen: input.amountYen,
    category: p.category,
    importance: input.importance,
  });

  db.prepare('UPDATE kakeibo_planned_expense SET next_day_key = ? WHERE id = ?').run(
    addDaysKey(p.next_day_key, p.cycle_days),
    id,
  );
  return entry;
}
