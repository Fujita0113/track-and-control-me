import type { DB } from '../db/index.js';
import { addDaysKey } from './day-key.js';
import { listEntries, type KakeiboEntryRow } from './kakeibo.js';
import { budgetDerived } from './kakeibo-budget.js';
import { monthOf } from './kakeibo-shared.js';

/**
 * 分析（spec: kakeibo-analysis・design D7・D10）。
 * 重要度の帯（4区画・内訳なしは独立区画）とカテゴリ→名称→明細の3段ドリル。
 * 割合はすべて四捨五入。
 */

function pct(amount: number, base: number): number {
  return base > 0 ? Math.round((amount / base) * 100) : 0;
}

/**
 * 複数区画の割合を合計ちょうど100%になるよう配分する（最大剰余法）。
 * 単純な四捨五入だと丸め誤差の蓄積で合計が100からずれることがあるため、
 * 重要度の帯（4区画で必ず100%）はこちらを使う。
 */
function distributePercents(amounts: number[], total: number): number[] {
  if (total <= 0) return amounts.map(() => 0);
  const raw = amounts.map((a) => (a / total) * 100);
  const floors = raw.map((r) => Math.floor(r));
  const remainder = 100 - floors.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac);
  const result = [...floors];
  for (let k = 0; k < remainder && k < order.length; k++) {
    result[order[k]!.i] = result[order[k]!.i]! + 1;
  }
  return result;
}

export interface ImportanceBucket {
  amountYen: number;
  pct: number;
}
export interface ImportanceBreakdown {
  totalYen: number;
  must: ImportanceBucket;
  semi: ImportanceBucket;
  waste: ImportanceBucket;
  noDetail: ImportanceBucket;
}

/** 重要度の帯（4区画・内訳なしを他の3区画に混ぜない・design D10）。 */
export function importanceBreakdown(db: DB, monthKey: string): ImportanceBreakdown {
  const entries = listEntries(db, monthKey);
  const totalYen = entries.reduce((a, e) => a + e.amount_yen, 0);

  const sumOf = (pred: (e: KakeiboEntryRow) => boolean): number =>
    entries.filter(pred).reduce((a, e) => a + e.amount_yen, 0);

  const mustYen = sumOf((e) => e.importance === 'MUST');
  const semiYen = sumOf((e) => e.importance === 'SEMI');
  const wasteYen = sumOf((e) => e.importance === 'WASTE');
  const noDetailYen = sumOf((e) => e.importance == null);

  const [mustPct, semiPct, wastePct, noDetailPct] = distributePercents(
    [mustYen, semiYen, wasteYen, noDetailYen],
    totalYen,
  ) as [number, number, number, number];

  return {
    totalYen,
    must: { amountYen: mustYen, pct: mustPct },
    semi: { amountYen: semiYen, pct: semiPct },
    waste: { amountYen: wasteYen, pct: wastePct },
    noDetail: { amountYen: noDetailYen, pct: noDetailPct },
  };
}

export interface AnalysisEntryRow {
  id: number;
  day_key: string;
  amount_yen: number;
  importance: string | null;
  detail: string | null;
  has_detail: boolean;
  has_receipt: boolean;
  receipt_id: number | null;
  name: string;
}
export interface CategoryTreeName {
  name: string;
  amountYen: number;
  pct: number;
  entries: AnalysisEntryRow[];
}
export interface CategoryTreeRow {
  category: string;
  amountYen: number;
  pct: number;
  names: CategoryTreeName[];
}

/** カテゴリ→名称（完全一致・降順）→明細（日付降順）（design D10・spec: kakeibo-analysis）。 */
export function categoryTree(db: DB, monthKey: string): CategoryTreeRow[] {
  const entries = listEntries(db, monthKey);
  const variableTotal = entries.reduce((a, e) => a + e.amount_yen, 0);

  const byCategory = new Map<string, KakeiboEntryRow[]>();
  for (const e of entries) {
    const list = byCategory.get(e.category) ?? [];
    list.push(e);
    byCategory.set(e.category, list);
  }

  const tree: CategoryTreeRow[] = [];
  for (const [category, catEntries] of byCategory) {
    const categoryAmountYen = catEntries.reduce((a, e) => a + e.amount_yen, 0);

    const byName = new Map<string, KakeiboEntryRow[]>();
    for (const e of catEntries) {
      const list = byName.get(e.name) ?? [];
      list.push(e);
      byName.set(e.name, list);
    }

    const names: CategoryTreeName[] = [...byName.entries()]
      .map(([name, nameEntries]) => {
        const amountYen = nameEntries.reduce((a, e) => a + e.amount_yen, 0);
        const sorted = [...nameEntries].sort((a, b) => (a.day_key < b.day_key ? 1 : a.day_key > b.day_key ? -1 : b.id - a.id));
        return {
          name,
          amountYen,
          pct: pct(amountYen, categoryAmountYen),
          entries: sorted.map((e) => ({
            id: e.id,
            day_key: e.day_key,
            amount_yen: e.amount_yen,
            importance: e.importance,
            detail: e.detail,
            has_detail: e.detail != null && e.detail !== '',
            has_receipt: e.receipt_id != null,
            receipt_id: e.receipt_id,
            name: e.name,
          })),
        };
      })
      .sort((a, b) => b.amountYen - a.amountYen);

    tree.push({ category, amountYen: categoryAmountYen, pct: pct(categoryAmountYen, variableTotal), names });
  }

  return tree;
}

export interface WeeklyBreakdownRow {
  weekFromDayKey: string;
  weekToDayKey: string;
  spentYen: number;
  targetYen: number;
  isPartial: boolean;
  inProgress: boolean;
}

/** 月曜始まりの週の月曜日（design: kakeibo-recent-forecast decision 3）。 */
function mondayOf(dayKey: string): string {
  const [y, m, d] = dayKey.split('-').map(Number);
  const date = new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1));
  const sinceMonday = (date.getUTCDay() + 6) % 7;
  return addDaysKey(dayKey, -sinceMonday);
}

/**
 * 分析タブの「週ごとの支出」（design: kakeibo-recent-forecast decision 3）。
 * `forecastMonth` の直近7日ローリング窓とは別物: ここは月境界をまたがず、月をまたぐ週は
 * その月に属する日数分だけの部分週として返す。
 */
export function weeklyBreakdown(db: DB, monthKey: string, todayDayKey: string): WeeklyBreakdownRow[] {
  const [y, m] = monthKey.split('-').map(Number);
  const year = y ?? 0;
  const month = m ?? 1;
  const firstDayKey = `${monthKey}-01`;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const lastDayKey = `${monthKey}-${String(lastDay).padStart(2, '0')}`;

  const targetYen = budgetDerived(db, monthKey).weeklyTargetYen;
  const isCurrentMonth = monthOf(todayDayKey) === monthKey;

  const weeks: WeeklyBreakdownRow[] = [];
  let naturalFrom = mondayOf(firstDayKey);
  while (naturalFrom <= lastDayKey) {
    const naturalTo = addDaysKey(naturalFrom, 6);
    const weekFromDayKey = naturalFrom < firstDayKey ? firstDayKey : naturalFrom;
    const weekToDayKey = naturalTo > lastDayKey ? lastDayKey : naturalTo;

    if (weekFromDayKey > todayDayKey) break;

    const isPartial = weekFromDayKey !== naturalFrom || weekToDayKey !== naturalTo;
    const inProgress = isCurrentMonth && todayDayKey >= weekFromDayKey && todayDayKey <= weekToDayKey;
    const spentYen = (
      db.prepare('SELECT COALESCE(SUM(amount_yen), 0) AS s FROM kakeibo_entry WHERE day_key BETWEEN ? AND ?').get(
        weekFromDayKey,
        weekToDayKey,
      ) as { s: number }
    ).s;

    weeks.push({ weekFromDayKey, weekToDayKey, spentYen, targetYen, isPartial, inProgress });
    naturalFrom = addDaysKey(naturalFrom, 7);
  }

  return weeks;
}
