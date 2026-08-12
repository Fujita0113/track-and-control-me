import type { DB } from '../db/index.js';
import { addDaysKey, dayDiff } from './day-key.js';
import { entryState, listEntries, type KakeiboEntryRow } from './kakeibo.js';
import { getBudget, budgetDerived, listFixedCosts, listPlannedExpenses } from './kakeibo-budget.js';
import { floor10, daysInMonth, monthOf } from './kakeibo-shared.js';

/**
 * 着地予想（spec: kakeibo-forecast・design D2・D5・D6・D7・D8）。
 * 期待値は ref/kakeibo/kakeibo-mock.html の「数字の筋書き」を凍結したもの
 * （design.md「数字の筋書き」・kakeibo-forecast.test.ts）。
 */

export type KakeiboForecastBasisKind = 'LAST' | 'ALL_AVG' | 'RECENT_N' | 'MANUAL';

export interface DayRateOpts {
  basis: KakeiboForecastBasisKind;
  recentN?: number;
  manualCycleDays?: number;
  manualAmountYen?: number;
}

export interface DayRateResult {
  ratePerDay: number | null;
  cycleDays: number | null;
  amountYen: number | null;
  sampleCount: number;
  coveredDays: number;
  excludedPendingCount: number;
}

/** 予想の計算基準ごとの日単価（design D5）。合計を合計で割る加重平均、日単価は floor。 */
export function dayRateFor(db: DB, name: string, opts: DayRateOpts, todayDayKey: string): DayRateResult {
  const rows = db
    .prepare('SELECT * FROM kakeibo_entry WHERE name = ? AND bulk_from IS NULL ORDER BY day_key DESC, id DESC')
    .all(name) as KakeiboEntryRow[];
  const confirmed = rows.filter((r) => r.actual_days != null);
  const excludedPendingCount = rows.filter(
    (r) => r.actual_days == null && entryState(r, todayDayKey) === 'PENDING',
  ).length;

  if (opts.basis === 'MANUAL') {
    const cycleDays = opts.manualCycleDays ?? 0;
    const amountYen = opts.manualAmountYen ?? 0;
    const ratePerDay = cycleDays > 0 ? Math.floor(amountYen / cycleDays) : null;
    return { ratePerDay, cycleDays, amountYen, sampleCount: 0, coveredDays: cycleDays, excludedPendingCount };
  }

  if (confirmed.length === 0) {
    return {
      ratePerDay: null,
      cycleDays: null,
      amountYen: null,
      sampleCount: 0,
      coveredDays: 0,
      excludedPendingCount,
    };
  }

  let samples = confirmed;
  if (opts.basis === 'LAST') samples = confirmed.slice(0, 1);
  else if (opts.basis === 'RECENT_N') samples = confirmed.slice(0, opts.recentN ?? 3);

  const sumAmt = samples.reduce((a, r) => a + r.amount_yen, 0);
  const sumDays = samples.reduce((a, r) => a + (r.actual_days ?? 0), 0);
  const ratePerDay = sumDays > 0 ? Math.floor(sumAmt / sumDays) : null;
  return {
    ratePerDay,
    cycleDays: sumDays / samples.length,
    amountYen: sumAmt / samples.length,
    sampleCount: samples.length,
    coveredDays: sumDays,
    excludedPendingCount,
  };
}

export interface ForecastBasisRow {
  name: string;
  basis: string;
  recent_n: number;
  manual_cycle_days: number | null;
  manual_amount_yen: number | null;
  updated_at: number;
}

export function getForecastBasis(db: DB, name: string): ForecastBasisRow {
  const row = db.prepare('SELECT * FROM kakeibo_forecast_basis WHERE name = ?').get(name) as
    | ForecastBasisRow
    | undefined;
  return row ?? { name, basis: 'ALL_AVG', recent_n: 3, manual_cycle_days: null, manual_amount_yen: null, updated_at: 0 };
}

export interface SetForecastBasisInput {
  basis: KakeiboForecastBasisKind;
  recentN?: number;
  manualCycleDays?: number;
  manualAmountYen?: number;
}

export function setForecastBasis(db: DB, name: string, input: SetForecastBasisInput): ForecastBasisRow {
  const now = Date.now();
  const recentN = input.recentN ?? 3;
  db.prepare(
    `INSERT INTO kakeibo_forecast_basis (name, basis, recent_n, manual_cycle_days, manual_amount_yen, updated_at)
     VALUES (@name, @basis, @recentN, @manualCycleDays, @manualAmountYen, @now)
     ON CONFLICT(name) DO UPDATE SET
       basis = @basis, recent_n = @recentN, manual_cycle_days = @manualCycleDays,
       manual_amount_yen = @manualAmountYen, updated_at = @now`,
  ).run({
    name,
    basis: input.basis,
    recentN,
    manualCycleDays: input.manualCycleDays ?? null,
    manualAmountYen: input.manualAmountYen ?? null,
    now,
  });
  return getForecastBasis(db, name);
}

function dayRateForStoredBasis(
  db: DB,
  name: string,
  todayDayKey: string,
  overrides?: Record<string, DayRateOpts>,
): DayRateResult {
  const override = overrides?.[name];
  if (override) return dayRateFor(db, name, override, todayDayKey);
  const b = getForecastBasis(db, name);
  return dayRateFor(
    db,
    name,
    {
      basis: b.basis as KakeiboForecastBasisKind,
      recentN: b.recent_n,
      manualCycleDays: b.manual_cycle_days ?? undefined,
      manualAmountYen: b.manual_amount_yen ?? undefined,
    },
    todayDayKey,
  );
}

export interface ForecastSourceRow {
  kind: 'STOCK' | 'SPORADIC' | 'MONTHLY_ROOM' | 'RESERVATION';
  name: string;
  category: string;
  ratePerDay?: number | null;
  pendingCount?: number;
  cycleDays?: number | null;
  sampleCount?: number;
  amountYen?: number;
  roomYen?: number;
  remainingYen?: number;
  dayKey?: string;
  basis?: string;
}

/**
 * 予想の計算基準の一覧（STOCK/SPORADIC/MONTHLY_ROOM/RESERVATION・design D2）。
 * `overrides` は基準モーダルの「保存せず出し直す」プレビュー用（design D14 の `/basis/:name/preview`）。
 */
export function listForecastSources(
  db: DB,
  monthKey: string,
  todayDayKey: string,
  overrides?: Record<string, DayRateOpts>,
): ForecastSourceRow[] {
  const rows: ForecastSourceRow[] = [];

  const stockNames = (
    db.prepare('SELECT DISTINCT name FROM kakeibo_entry WHERE planned_days >= 2 AND bulk_from IS NULL').all() as {
      name: string;
    }[]
  ).map((r) => r.name);
  for (const name of stockNames) {
    const rate = dayRateForStoredBasis(db, name, todayDayKey, overrides);
    if (rate.ratePerDay == null) continue;
    const latest = db
      .prepare('SELECT category FROM kakeibo_entry WHERE name = ? ORDER BY day_key DESC, id DESC LIMIT 1')
      .get(name) as { category: string } | undefined;
    rows.push({
      kind: 'STOCK',
      name,
      category: latest?.category ?? 'FOOD',
      ratePerDay: rate.ratePerDay,
      pendingCount: rate.excludedPendingCount,
      cycleDays: rate.cycleDays,
      sampleCount: rate.sampleCount,
      amountYen: rate.amountYen ?? undefined,
      basis: overrides?.[name] ? overrides[name]!.basis : getForecastBasis(db, name).basis,
    });
  }

  const dayOfMonth = Number(todayDayKey.slice(8, 10));
  for (const category of ['FOOD', 'DAILY']) {
    const sum = (
      db
        .prepare(
          `SELECT COALESCE(SUM(amount_yen), 0) AS s FROM kakeibo_entry
           WHERE category = ? AND planned_days <= 1 AND bulk_from IS NULL AND day_key LIKE ?`,
        )
        .get(category, `${monthKey}%`) as { s: number }
    ).s;
    if (sum <= 0 || dayOfMonth <= 0) continue;
    rows.push({ kind: 'SPORADIC', name: category, category, ratePerDay: Math.floor(sum / dayOfMonth), amountYen: sum });
  }

  for (const category of ['FUN', 'SUDDEN']) {
    const monthTotals = db
      .prepare(
        `SELECT substr(day_key, 1, 7) AS m, SUM(amount_yen) AS s FROM kakeibo_entry
         WHERE category = ? AND bulk_from IS NULL GROUP BY m`,
      )
      .all(category) as { m: string; s: number }[];
    const past = monthTotals
      .filter((x) => x.m < monthKey)
      .sort((a, b) => b.m.localeCompare(a.m))
      .slice(0, 3);
    if (past.length === 0) continue;
    const roomYen = Math.floor(past.reduce((a, x) => a + x.s, 0) / past.length);
    const thisMonthTotal = (
      db
        .prepare(`SELECT COALESCE(SUM(amount_yen), 0) AS s FROM kakeibo_entry WHERE category = ? AND bulk_from IS NULL AND day_key LIKE ?`)
        .get(category, `${monthKey}%`) as { s: number }
    ).s;
    const remainingYen = Math.max(0, roomYen - thisMonthTotal);
    if (remainingYen <= 0) continue;
    rows.push({ kind: 'MONTHLY_ROOM', name: category, category, roomYen, remainingYen });
  }

  for (const p of listPlannedExpenses(db, { monthKey, fromDayKey: todayDayKey })) {
    rows.push({ kind: 'RESERVATION', name: p.name, category: p.category, amountYen: p.amount_yen, dayKey: p.next_day_key });
  }

  return rows;
}

export interface ForecastSeriesPoint {
  dayKey: string;
  kind: 'ACTUAL' | 'FORECAST';
  cumulativeYen: number;
  reservationYen: number;
}

export interface ForecastMonthResult {
  fixedYen: number;
  variableActualYen: number;
  actualYen: number;
  remainingDays: number;
  forecastYen: number;
  landingYen: number;
  capYen: number;
  overYen: number;
  crossDayKey: string | null;
  series: ForecastSeriesPoint[];
}

/**
 * 残り日を1日ずつ歩いて series を積む（閉じた式にしない・design D6）。
 * `overrides` は基準を保存せずに着地予想を出し直すプレビュー用。
 */
export function forecastMonth(
  db: DB,
  monthKey: string,
  todayDayKey: string,
  overrides?: Record<string, DayRateOpts>,
): ForecastMonthResult {
  const fixedYen = listFixedCosts(db, monthKey).reduce((a, r) => a + r.amount_yen, 0);
  const entries = listEntries(db, monthKey);
  const variableActualYen = entries.reduce((a, r) => a + r.amount_yen, 0);
  const actualYen = fixedYen + variableActualYen;
  const capYen = getBudget(db, monthKey).cap_yen;

  const days = daysInMonth(monthKey);
  const todayDayNum = Number(todayDayKey.slice(8, 10));
  const remainingDays = Math.max(0, days - todayDayNum);

  const sources = listForecastSources(db, monthKey, todayDayKey, overrides);
  const dailySlope = sources
    .filter((s) => s.kind === 'STOCK' || s.kind === 'SPORADIC')
    .reduce((a, s) => a + (s.ratePerDay ?? 0), 0);
  const monthlyRoomDaily =
    remainingDays > 0
      ? sources
          .filter((s) => s.kind === 'MONTHLY_ROOM')
          .reduce((a, s) => a + Math.floor((s.remainingYen ?? 0) / remainingDays), 0)
      : 0;

  const reservationsByDay = new Map<string, number>();
  for (const s of sources) {
    if (s.kind === 'RESERVATION' && s.dayKey) {
      reservationsByDay.set(s.dayKey, (reservationsByDay.get(s.dayKey) ?? 0) + (s.amountYen ?? 0));
    }
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
    const reservationYen = reservationsByDay.get(dayKey) ?? 0;
    if (d <= todayDayNum) {
      cumulative += entriesByDay.get(dayKey) ?? 0;
      series.push({ dayKey, kind: 'ACTUAL', cumulativeYen: cumulative, reservationYen });
    } else {
      cumulative += dailySlope + monthlyRoomDaily + reservationYen;
      series.push({ dayKey, kind: 'FORECAST', cumulativeYen: cumulative, reservationYen });
    }
    if (crossDayKey == null && cumulative > capYen) crossDayKey = dayKey;
  }

  const last = series[series.length - 1];
  const landingYen = last ? last.cumulativeYen : actualYen;
  const forecastYen = landingYen - actualYen;
  const overYen = Math.max(0, landingYen - capYen);

  return {
    fixedYen,
    variableActualYen,
    actualYen,
    remainingDays,
    forecastYen,
    landingYen,
    capYen,
    overYen,
    crossDayKey,
    series,
  };
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

/** 今週使える残り（月曜始まり・残り日数は今日を含む・design D8）。 */
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

/** 「不要な支出」の合計と上限（design D7・割合は四捨五入）。 */
export function wasteSummary(db: DB, monthKey: string, _todayDayKey: string): WasteSummary {
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
