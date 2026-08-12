import type { DB } from '../db/index.js';
import { listEntries, type KakeiboEntryRow } from './kakeibo.js';

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
  planned_days: number;
  actual_days: number | null;
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
            planned_days: e.planned_days,
            actual_days: e.actual_days,
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
