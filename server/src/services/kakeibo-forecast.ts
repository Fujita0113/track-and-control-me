import type { DB } from '../db/index.js';
import { addDaysKey, dayDiff } from './day-key.js';
import { isSpecialEntry, listEntries, type KakeiboEntryRow } from './kakeibo.js';
import { getBudget, budgetDerived, listFixedCosts, listPlannedExpenses } from './kakeibo-budget.js';
import { floor10, daysInMonth, monthOf } from './kakeibo-shared.js';

/**
 * 月末予想（spec: kakeibo-forecast・design D2・D3・D4・D5・D6）。
 *
 * 予想は「日々の出費 ÷ 経過日数 × 残り日数」の一本だけ。名称ごとの周期は持たない。
 * 期待値は ref/kakeibo/kakeibo-mock.html の筋書き（design.md「数字の筋書き」）を凍結したもの:
 *   実績 40,030 / 計算対象 19,350 / 1日平均 1,759 / 月末 77,010 / 超過日 8/23
 */

/** overrides は名称→特別費の「保存しない」上書き（design D3・D14の調整モーダル用）。 */
function effectiveSpecial(entry: KakeiboEntryRow, overrides?: Record<string, boolean>): boolean {
  if (entry.category === 'SUDDEN') return true; // 自動。手では戻せない。
  if (overrides && Object.prototype.hasOwnProperty.call(overrides, entry.name)) {
    return !!overrides[entry.name];
  }
  return isSpecialEntry(entry);
}

export interface ForecastSeriesPoint {
  dayKey: string;
  kind: 'ACTUAL' | 'FORECAST';
  cumulativeYen: number;
  plannedYen: number;
}

export interface ForecastMonthResult {
  fixedYen: number;
  variableActualYen: number;
  actualYen: number;
  specialYen: number;
  dailyPoolYen: number;
  elapsedDays: number;
  remainingDays: number;
  dailyAverageYen: number;
  forecastYen: number;
  plannedYen: number;
  landingYen: number;
  capYen: number;
  overYen: number;
  crossDayKey: string | null;
  series: ForecastSeriesPoint[];
}

/**
 * 月末予想を残り日を1日ずつ歩いて積む（閉じた式にしない・design D5）。
 * `overrides` は特別費の名称→真偽の「保存しない」上書き（調整モーダルのプレビュー・design D3・D14）。
 */
export function forecastMonth(
  db: DB,
  monthKey: string,
  todayDayKey: string,
  overrides?: Record<string, boolean>,
): ForecastMonthResult {
  const fixedYen = listFixedCosts(db, monthKey).reduce((a, r) => a + r.amount_yen, 0);
  const entries = listEntries(db, monthKey);
  const variableActualYen = entries.reduce((a, e) => a + e.amount_yen, 0);
  const actualYen = fixedYen + variableActualYen;
  const capYen = getBudget(db, monthKey).cap_yen;

  const specialYen = entries.filter((e) => effectiveSpecial(e, overrides)).reduce((a, e) => a + e.amount_yen, 0);
  const dailyPoolYen = variableActualYen - specialYen;

  const days = daysInMonth(monthKey);
  const elapsedDays = Number(todayDayKey.slice(8, 10));
  const remainingDays = Math.max(0, days - elapsedDays);
  const dailyAverageYen = elapsedDays > 0 ? Math.floor(dailyPoolYen / elapsedDays) : 0;
  const forecastYen = dailyAverageYen * remainingDays;

  const tomorrow = addDaysKey(todayDayKey, 1);
  const plannedRows = listPlannedExpenses(db, { monthKey, fromDayKey: tomorrow });
  const plannedYen = plannedRows.reduce((a, r) => a + r.amount_yen, 0);
  const plannedByDay = new Map<string, number>();
  for (const r of plannedRows) {
    plannedByDay.set(r.next_day_key, (plannedByDay.get(r.next_day_key) ?? 0) + r.amount_yen);
  }

  const entriesByDay = new Map<string, number>();
  for (const e of entries) {
    entriesByDay.set(e.day_key, (entriesByDay.get(e.day_key) ?? 0) + e.amount_yen);
  }

  const series: ForecastSeriesPoint[] = [];
  let cumulative = fixedYen;
  let crossDayKey: string | null = null;
  for (let d = 1; d <= days; d++) {
    const dayKey = `${monthKey}-${String(d).padStart(2, '0')}`;
    if (d <= elapsedDays) {
      cumulative += entriesByDay.get(dayKey) ?? 0;
      series.push({ dayKey, kind: 'ACTUAL', cumulativeYen: cumulative, plannedYen: 0 });
    } else {
      const dayPlanned = plannedByDay.get(dayKey) ?? 0;
      cumulative += dailyAverageYen + dayPlanned;
      series.push({ dayKey, kind: 'FORECAST', cumulativeYen: cumulative, plannedYen: dayPlanned });
    }
    if (crossDayKey == null && cumulative > capYen) crossDayKey = dayKey;
  }

  const last = series[series.length - 1];
  const landingYen = last ? last.cumulativeYen : actualYen + forecastYen + plannedYen;
  const overYen = Math.max(0, landingYen - capYen);

  return {
    fixedYen,
    variableActualYen,
    actualYen,
    specialYen,
    dailyPoolYen,
    elapsedDays,
    remainingDays,
    dailyAverageYen,
    forecastYen,
    plannedYen,
    landingYen,
    capYen,
    overYen,
    crossDayKey,
    series,
  };
}

export interface AdjustRow {
  name: string;
  amountYen: number;
  count: number;
  isSpecial: boolean;
  auto: boolean;
}

/** 調整モーダルの一覧（名称ごと・金額降順・design D3・D14）。 */
export function listAdjustRows(db: DB, monthKey: string, _todayDayKey: string): AdjustRow[] {
  const entries = listEntries(db, monthKey);
  const byName = new Map<string, KakeiboEntryRow[]>();
  for (const e of entries) {
    const list = byName.get(e.name) ?? [];
    list.push(e);
    byName.set(e.name, list);
  }
  const rows: AdjustRow[] = [...byName.entries()].map(([name, list]) => ({
    name,
    amountYen: list.reduce((a, e) => a + e.amount_yen, 0),
    count: list.length,
    isSpecial: list.every((e) => isSpecialEntry(e)),
    auto: list.every((e) => e.category === 'SUDDEN'),
  }));
  return rows.sort((a, b) => b.amountYen - a.amountYen);
}

/**
 * 上限ぶんを抑えたときの月末超過の変化（design D4）。
 * `reducibleYen` は実際に使わなかった想定なので、実績（actual）と母数（pool）の両方から引く。
 */
export interface WasteReductionEffect {
  reducibleYen: number;
  overNowYen: number;
  overAfterYen: number;
}

export function wasteReductionEffect(db: DB, monthKey: string, todayDayKey: string): WasteReductionEffect {
  const w = wasteSummary(db, monthKey);
  const reducibleYen = Math.max(0, w.totalYen - w.capYen);
  const f = forecastMonth(db, monthKey, todayDayKey);
  const overNowYen = f.overYen;
  if (reducibleYen === 0) {
    return { reducibleYen, overNowYen, overAfterYen: overNowYen };
  }
  const newActualYen = f.actualYen - reducibleYen;
  const newDailyPoolYen = f.dailyPoolYen - reducibleYen;
  const newDailyAverageYen = f.elapsedDays > 0 ? Math.floor(newDailyPoolYen / f.elapsedDays) : 0;
  const newForecastYen = newDailyAverageYen * f.remainingDays;
  const newLandingYen = newActualYen + newForecastYen + f.plannedYen;
  const overAfterYen = Math.max(0, newLandingYen - f.capYen);
  return { reducibleYen, overNowYen, overAfterYen };
}

export interface WeeklyRemaining {
  weekFromDayKey: string;
  weekToDayKey: string;
  remainingDays: number;
  targetYen: number;
  spentYen: number;
  remainingYen: number;
  perDayYen: number;
}

/** 今週の残り予算（月曜始まり・残り日数は今日を含む・design D7）。 */
export function weeklyRemaining(db: DB, dayKey: string): WeeklyRemaining {
  const [y, m, d] = dayKey.split('-').map(Number);
  const date = new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1));
  const sinceMonday = (date.getUTCDay() + 6) % 7;
  const weekFromDayKey = addDaysKey(dayKey, -sinceMonday);
  const weekToDayKey = addDaysKey(weekFromDayKey, 6);
  const remainingDays = dayDiff(dayKey, weekToDayKey) + 1;

  const targetYen = budgetDerived(db, monthOf(dayKey)).weeklyTargetYen;
  const spent = (
    db.prepare('SELECT COALESCE(SUM(amount_yen), 0) AS s FROM kakeibo_entry WHERE day_key BETWEEN ? AND ?').get(
      weekFromDayKey,
      weekToDayKey,
    ) as { s: number }
  ).s;
  const remainingYen = targetYen - spent;
  const perDayYen = remainingDays > 0 ? floor10(remainingYen / remainingDays) : 0;

  return { weekFromDayKey, weekToDayKey, remainingDays, targetYen, spentYen: spent, remainingYen, perDayYen };
}

export interface WasteSummaryRow {
  name: string;
  amountYen: number;
  count: number;
}
export interface WasteSummary {
  totalYen: number;
  capYen: number;
  overYen: number;
  ratioPct: number;
  rows: WasteSummaryRow[];
}

/** 「無駄遣い」の合計と上限（design D6・割合は四捨五入）。 */
export function wasteSummary(db: DB, monthKey: string): WasteSummary {
  const entries = listEntries(db, monthKey);
  const wasteEntries = entries.filter((e) => e.importance === 'WASTE');
  const totalYen = wasteEntries.reduce((a, e) => a + e.amount_yen, 0);
  const variableTotal = entries.reduce((a, e) => a + e.amount_yen, 0);
  const capYen = getBudget(db, monthKey).waste_cap_yen;
  const overYen = Math.max(0, totalYen - capYen);
  const ratioPct = variableTotal > 0 ? Math.round((totalYen / variableTotal) * 100) : 0;

  const byName = new Map<string, WasteSummaryRow>();
  for (const e of wasteEntries) {
    const cur = byName.get(e.name) ?? { name: e.name, amountYen: 0, count: 0 };
    cur.amountYen += e.amount_yen;
    cur.count += 1;
    byName.set(e.name, cur);
  }
  const rows = [...byName.values()].sort((a, b) => b.amountYen - a.amountYen);

  return { totalYen, capYen, overYen, ratioPct, rows };
}
