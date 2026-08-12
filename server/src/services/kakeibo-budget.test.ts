import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../db/index.js';
import { listEntries } from './kakeibo.js';
import {
  getBudget,
  setBudget,
  listFixedCosts,
  upsertFixedCost,
  deleteFixedCost,
  importFixedCostsFromPrevMonth,
  budgetDerived,
  listPlannedExpenses,
  upsertPlannedExpense,
  recordPlannedExpense,
  KakeiboBudgetError,
} from './kakeibo-budget.js';

/**
 * 予算（spec: kakeibo-budget）。
 * 上限 62,000 − 固定費 17,380 = 変動費 44,620 → 週の目標 10,070（design D7・D6）。
 */

const MONTH = '2026-08';
const PREV = '2026-07';
const TODAY = '2026-08-11';

let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
});

function seedFixed(month: string): void {
  upsertFixedCost(db, month, { name: '電気代', amountYen: 8_500 });
  upsertFixedCost(db, month, { name: 'ガス代', amountYen: 3_000 });
  upsertFixedCost(db, month, { name: '通信費', amountYen: 4_400 });
  upsertFixedCost(db, month, { name: 'サブスク', amountYen: 1_480 });
}

describe('月の上限と変動費・週の目標（kakeibo-budget）', () => {
  it('変動費に使える = 上限 − 固定費の合計', () => {
    setBudget(db, MONTH, { capYen: 62_000, wasteCapYen: 4_000 });
    seedFixed(MONTH);
    const d = budgetDerived(db, MONTH);
    expect(d.fixedTotalYen).toBe(17_380);
    expect(d.variableYen).toBe(44_620);
  });

  it('週の目標 = floor10(変動費 ÷ 月の日数 × 7) = 10,070', () => {
    setBudget(db, MONTH, { capYen: 62_000, wasteCapYen: 4_000 });
    seedFixed(MONTH);
    const d = budgetDerived(db, MONTH);
    expect(d.daysInMonth).toBe(31);
    expect(d.weeklyTargetYen).toBe(10_070);
  });

  it('上限を変えると変動費も週の目標も追随する（保存しない・design D8）', () => {
    setBudget(db, MONTH, { capYen: 62_000, wasteCapYen: 4_000 });
    seedFixed(MONTH);
    setBudget(db, MONTH, { capYen: 70_000 });
    const d = budgetDerived(db, MONTH);
    expect(d.variableYen).toBe(52_620);
    expect(d.weeklyTargetYen).toBe(11_880); // floor10(52620 / 31 * 7 = 11881.9)
  });

  it('固定費を1件変えると変動費も追随する', () => {
    setBudget(db, MONTH, { capYen: 62_000, wasteCapYen: 4_000 });
    seedFixed(MONTH);
    upsertFixedCost(db, MONTH, { name: '電気代', amountYen: 9_500 });
    expect(budgetDerived(db, MONTH).variableYen).toBe(43_620);
  });

  it('予算が未設定の月は上限 0 として扱い、例外を投げない', () => {
    expect(() => budgetDerived(db, '2026-09')).not.toThrow();
    expect(budgetDerived(db, '2026-09').variableYen).toBe(0);
  });

  it('上限に負の値は入れられない', () => {
    expect(() => setBudget(db, MONTH, { capYen: -1 })).toThrow(KakeiboBudgetError);
  });
});

describe('固定費の予想（kakeibo-budget）', () => {
  it('前月から取り込むと同じ名称・金額の行ができる', () => {
    seedFixed(PREV);
    importFixedCostsFromPrevMonth(db, MONTH);
    const rows = listFixedCosts(db, MONTH);
    expect([...rows.map((r) => r.name)].sort()).toEqual(['ガス代', 'サブスク', '通信費', '電気代'].sort());
    expect(rows.find((r) => r.name === '電気代')!.amount_yen).toBe(8_500);
  });

  it('既にある名称は上書きしない（新しい行だけ足す）', () => {
    seedFixed(PREV);
    upsertFixedCost(db, MONTH, { name: '電気代', amountYen: 9_000 });
    importFixedCostsFromPrevMonth(db, MONTH);
    expect(listFixedCosts(db, MONTH).find((r) => r.name === '電気代')!.amount_yen).toBe(9_000);
    expect(listFixedCosts(db, MONTH)).toHaveLength(4);
  });

  it('前月の金額を参考として引ける', () => {
    seedFixed(PREV);
    upsertFixedCost(db, MONTH, { name: '電気代', amountYen: 8_500 });
    const row = listFixedCosts(db, MONTH).find((r) => r.name === '電気代')!;
    expect(row.prev_amount_yen).toBe(8_500);
  });

  it('前月に行が無ければ参考値は null', () => {
    upsertFixedCost(db, MONTH, { name: '新しい固定費', amountYen: 1_000 });
    expect(listFixedCosts(db, MONTH)[0]!.prev_amount_yen).toBeNull();
  });

  it('削除できる', () => {
    seedFixed(MONTH);
    const id = listFixedCosts(db, MONTH).find((r) => r.name === 'サブスク')!.id;
    deleteFixedCost(db, id);
    expect(listFixedCosts(db, MONTH)).toHaveLength(3);
  });

  it('予算は月ごとに独立している', () => {
    setBudget(db, PREV, { capYen: 50_000, wasteCapYen: 3_000 });
    setBudget(db, MONTH, { capYen: 62_000, wasteCapYen: 4_000 });
    setBudget(db, PREV, { capYen: 55_000 });
    expect(getBudget(db, MONTH).cap_yen).toBe(62_000);
  });
});

describe('毎月の予定出費（kakeibo-budget）', () => {
  beforeEach(() => {
    upsertPlannedExpense(db, { name: '床屋', category: 'SUDDEN', cycleDays: 30, nextDayKey: '2026-08-20', amountYen: 1_800 });
    upsertPlannedExpense(db, { name: 'コンタクト', category: 'DAILY', cycleDays: 90, nextDayKey: '2026-09-14', amountYen: 4_200 });
  });

  it('予定出費は支出レコードを作らない（予想にだけ入る・design D9）', () => {
    expect(listEntries(db, MONTH)).toHaveLength(0);
    expect(listPlannedExpenses(db)).toHaveLength(2);
  });

  it('記録すると実績が作られ、次回が周期ぶん進む', () => {
    const p = listPlannedExpenses(db).find((x) => x.name === '床屋')!;
    const entry = recordPlannedExpense(db, p.id, { dayKey: '2026-08-20', amountYen: 2_000, importance: 'MUST' });
    expect(entry.amount_yen).toBe(2_000); // 目安 1,800 ではなく実際の金額
    expect(entry.name).toBe('床屋');
    expect(listEntries(db, MONTH)).toHaveLength(1);
    // 8/20 + 30日 = 9/19
    expect(listPlannedExpenses(db).find((x) => x.id === p.id)!.next_day_key).toBe('2026-09-19');
  });

  it('その月の予定チップは残り日にあるものだけ', () => {
    const chips = listPlannedExpenses(db, { monthKey: MONTH, fromDayKey: TODAY });
    expect(chips.map((c) => c.name)).toEqual(['床屋']); // コンタクトは9月なので出ない
  });

  it('周期0以下は拒否する', () => {
    expect(() => upsertPlannedExpense(db, { name: 'x', category: 'FOOD', cycleDays: 0, nextDayKey: '2026-08-20', amountYen: 100 }))
      .toThrow(KakeiboBudgetError);
  });
});

describe('「いらない」の上限（kakeibo-budget）', () => {
  it('月ごとに設定できる', () => {
    setBudget(db, MONTH, { capYen: 62_000, wasteCapYen: 4_000 });
    expect(getBudget(db, MONTH).waste_cap_yen).toBe(4_000);
    setBudget(db, MONTH, { wasteCapYen: 5_000 });
    expect(getBudget(db, MONTH).waste_cap_yen).toBe(5_000);
    expect(getBudget(db, MONTH).cap_yen).toBe(62_000); // 片方だけ変えても他方は保つ
  });
});
