import type { FastifyInstance } from 'fastify';
import type { ApiDeps } from './types.js';
import { todayKey } from '../services/summary.js';
import { monthOf } from '../services/kakeibo-shared.js';
import {
  createEntry,
  updateEntry,
  listEntries,
  suggestNames,
  pendingConfirmation,
  confirmActualDays,
  createBulkEntry,
  monthCoverage,
  declareZeroDay,
  createReceipt,
  getReceiptBytes,
  entryState,
  KakeiboError,
  type CreateEntryInput,
} from '../services/kakeibo.js';
import {
  getBudget,
  setBudget,
  listFixedCosts,
  upsertFixedCost,
  updateFixedCost,
  deleteFixedCost,
  importFixedCostsFromPrevMonth,
  budgetDerived,
  listPlannedExpenses,
  upsertPlannedExpense,
  deletePlannedExpense,
  recordPlannedExpense,
  KakeiboBudgetError,
} from '../services/kakeibo-budget.js';
import {
  dayRateFor,
  getForecastBasis,
  setForecastBasis,
  listForecastSources,
  forecastMonth,
  weeklyRemaining,
  wasteSummary,
  type DayRateOpts,
  type KakeiboForecastBasisKind,
} from '../services/kakeibo-forecast.js';
import { importanceBreakdown, categoryTree } from '../services/kakeibo-analysis.js';
import { prevMonthKey } from '../services/kakeibo-shared.js';

/** 家計簿 API（design D14「画面1つにつきエンドポイント1つ」・spec: kakeibo-*）。 */
export function registerKakeiboRoutes(app: FastifyInstance, deps: ApiDeps): void {
  const { db } = deps;

  const currentMonth = (): string => monthOf(todayKey(db));

  function replyKakeiboError(err: unknown, reply: { code: (n: number) => void }): Record<string, unknown> {
    if (err instanceof KakeiboError || err instanceof KakeiboBudgetError) {
      reply.code(400);
      return { error: err.message };
    }
    throw err;
  }

  function monthParam(req: { query: unknown }): string {
    const q = req.query as { month?: string };
    return q.month ?? currentMonth();
  }

  // --- 画面単位の GET（design D14）-----------------------------------------

  app.get('/api/kakeibo/home', async (req) => {
    const month = monthParam(req);
    const today = todayKey(db);
    return {
      month,
      today,
      forecast: forecastMonth(db, month, today),
      sources: listForecastSources(db, month, today),
      week: weeklyRemaining(db, today),
      waste: wasteSummary(db, month, today),
      plannedChips: listPlannedExpenses(db, { monthKey: month, fromDayKey: today }),
    };
  });

  app.get('/api/kakeibo/history', async (req) => {
    const month = monthParam(req);
    const today = todayKey(db);
    const entries = listEntries(db, month).map((e) => ({ ...e, state: entryState(e, today) }));
    return { entries, coverage: monthCoverage(db, month, today) };
  });

  app.get('/api/kakeibo/day-edit', async (req) => {
    const month = monthParam(req);
    const today = todayKey(db);
    const prev = prevMonthKey(month);
    const rows = [...listEntries(db, prev), ...listEntries(db, month)]
      .filter((r) => r.planned_days >= 2 && !r.bulk_from)
      .sort((a, b) => (a.day_key < b.day_key ? 1 : a.day_key > b.day_key ? -1 : b.id - a.id))
      .map((r) => ({ ...r, state: entryState(r, today) }));
    const names = [...new Set(rows.map((r) => r.name))];
    const summaries = names.map((name) => ({
      name,
      lastRate: dayRateFor(db, name, { basis: 'LAST' }, today),
      allAvgRate: dayRateFor(db, name, { basis: 'ALL_AVG' }, today),
      currentBasis: getForecastBasis(db, name).basis,
    }));
    return { rows, summaries };
  });

  app.get('/api/kakeibo/analysis', async (req) => {
    const month = monthParam(req);
    return { importance: importanceBreakdown(db, month), tree: categoryTree(db, month) };
  });

  app.get('/api/kakeibo/budget', async (req) => {
    const month = monthParam(req);
    return {
      budget: getBudget(db, month),
      fixedCosts: listFixedCosts(db, month),
      plannedExpenses: listPlannedExpenses(db, { monthKey: month }),
      derived: budgetDerived(db, month),
    };
  });

  // --- 台帳 -----------------------------------------------------------------

  app.post('/api/kakeibo/entries', async (req, reply) => {
    const b = (req.body ?? {}) as Partial<CreateEntryInput> & { dayKey?: string };
    try {
      return createEntry(db, {
        dayKey: b.dayKey ?? todayKey(db),
        name: b.name ?? '',
        amountYen: Number(b.amountYen),
        category: b.category ?? '',
        importance: b.importance ?? '',
        plannedDays: b.plannedDays,
        receiptId: b.receiptId ?? null,
        confirm: b.confirm,
      });
    } catch (err) {
      return replyKakeiboError(err, reply);
    }
  });

  app.get('/api/kakeibo/entries/pending', async (req) => {
    const q = req.query as { name?: string; day?: string };
    return pendingConfirmation(db, q.name ?? '', q.day ?? todayKey(db));
  });

  app.patch('/api/kakeibo/entries/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const b = (req.body ?? {}) as Record<string, unknown>;
    try {
      return updateEntry(db, id, {
        plannedDays: b.plannedDays as number | undefined,
        actualDays: b.actualDays as number | null | undefined,
        amountYen: b.amountYen as number | undefined,
        category: b.category as string | undefined,
        importance: b.importance as string | null | undefined,
        receiptId: b.receiptId as number | null | undefined,
      });
    } catch (err) {
      return replyKakeiboError(err, reply);
    }
  });

  app.post('/api/kakeibo/entries/:id/confirm', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const b = (req.body ?? {}) as { choice?: 'REMAINING' | 'TODAY' | 'EARLIER'; n?: number; asOfDayKey?: string };
    try {
      return confirmActualDays(db, id, { choice: b.choice ?? 'TODAY', n: b.n }, b.asOfDayKey);
    } catch (err) {
      return replyKakeiboError(err, reply);
    }
  });

  app.post('/api/kakeibo/entries/bulk', async (req, reply) => {
    const b = (req.body ?? {}) as { fromDayKey?: string; toDayKey?: string; amountYen?: number };
    try {
      return createBulkEntry(db, {
        fromDayKey: b.fromDayKey ?? '',
        toDayKey: b.toDayKey ?? '',
        amountYen: Number(b.amountYen),
      });
    } catch (err) {
      return replyKakeiboError(err, reply);
    }
  });

  app.post('/api/kakeibo/zero-day', async (req) => {
    const b = (req.body ?? {}) as { dayKey?: string };
    declareZeroDay(db, b.dayKey ?? todayKey(db));
    return { ok: true };
  });

  app.get('/api/kakeibo/names', async (req) => {
    const q = req.query as { prefix?: string };
    return suggestNames(db, q.prefix ?? '');
  });

  // --- 予想の計算基準 ---------------------------------------------------------

  app.get('/api/kakeibo/basis/:name', async (req) => {
    const name = decodeURIComponent((req.params as { name: string }).name);
    return getForecastBasis(db, name);
  });

  app.put('/api/kakeibo/basis/:name', async (req) => {
    const name = decodeURIComponent((req.params as { name: string }).name);
    const b = (req.body ?? {}) as {
      basis?: KakeiboForecastBasisKind;
      recentN?: number;
      manualCycleDays?: number;
      manualAmountYen?: number;
    };
    return setForecastBasis(db, name, {
      basis: b.basis ?? 'ALL_AVG',
      recentN: b.recentN,
      manualCycleDays: b.manualCycleDays,
      manualAmountYen: b.manualAmountYen,
    });
  });

  app.get('/api/kakeibo/basis/:name/preview', async (req) => {
    const name = decodeURIComponent((req.params as { name: string }).name);
    const q = req.query as {
      basis?: KakeiboForecastBasisKind;
      recentN?: string;
      manualCycleDays?: string;
      manualAmountYen?: string;
      month?: string;
    };
    const today = todayKey(db);
    const month = q.month ?? currentMonth();
    const opts: DayRateOpts = {
      basis: q.basis ?? 'ALL_AVG',
      recentN: q.recentN ? Number(q.recentN) : undefined,
      manualCycleDays: q.manualCycleDays ? Number(q.manualCycleDays) : undefined,
      manualAmountYen: q.manualAmountYen ? Number(q.manualAmountYen) : undefined,
    };
    return {
      rate: dayRateFor(db, name, opts, today),
      forecast: forecastMonth(db, month, today, { [name]: opts }),
    };
  });

  // --- レシート ---------------------------------------------------------------

  app.post('/api/kakeibo/receipts', async (req, reply) => {
    const b = (req.body ?? {}) as { dataUrl?: string; width?: number | null; height?: number | null };
    try {
      return createReceipt(db, { dataUrl: b.dataUrl ?? '', width: b.width ?? null, height: b.height ?? null });
    } catch (err) {
      return replyKakeiboError(err, reply);
    }
  });

  app.get('/api/kakeibo/receipts/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const r = getReceiptBytes(db, id);
    if (!r) {
      reply.code(404);
      return { error: '見つかりません' };
    }
    return reply.type(r.mime).send(r.bytes);
  });

  // --- 予算・固定費・予定出費 --------------------------------------------------

  app.put('/api/kakeibo/budget', async (req, reply) => {
    const month = monthParam(req);
    const b = (req.body ?? {}) as { capYen?: number; wasteCapYen?: number };
    try {
      return setBudget(db, month, b);
    } catch (err) {
      return replyKakeiboError(err, reply);
    }
  });

  app.post('/api/kakeibo/fixed-costs', async (req) => {
    const month = monthParam(req);
    const b = (req.body ?? {}) as { name?: string; amountYen?: number };
    upsertFixedCost(db, month, { name: b.name ?? '', amountYen: Number(b.amountYen) });
    return { ok: true, fixedCosts: listFixedCosts(db, month) };
  });

  app.patch('/api/kakeibo/fixed-costs/:id', async (req) => {
    const id = Number((req.params as { id: string }).id);
    const b = (req.body ?? {}) as { name?: string; amountYen?: number };
    updateFixedCost(db, id, { name: b.name, amountYen: b.amountYen });
    return { ok: true };
  });

  app.delete('/api/kakeibo/fixed-costs/:id', async (req) => {
    deleteFixedCost(db, Number((req.params as { id: string }).id));
    return { ok: true };
  });

  app.post('/api/kakeibo/fixed-costs/import', async (req) => {
    const month = monthParam(req);
    importFixedCostsFromPrevMonth(db, month);
    return { ok: true, fixedCosts: listFixedCosts(db, month) };
  });

  app.post('/api/kakeibo/planned-expenses', async (req, reply) => {
    const b = (req.body ?? {}) as {
      name?: string;
      category?: string;
      cycleDays?: number;
      nextDayKey?: string;
      amountYen?: number;
    };
    try {
      return upsertPlannedExpense(db, {
        name: b.name ?? '',
        category: b.category ?? '',
        cycleDays: Number(b.cycleDays),
        nextDayKey: b.nextDayKey ?? '',
        amountYen: Number(b.amountYen),
      });
    } catch (err) {
      return replyKakeiboError(err, reply);
    }
  });

  app.patch('/api/kakeibo/planned-expenses/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const b = (req.body ?? {}) as {
      name?: string;
      category?: string;
      cycleDays?: number;
      nextDayKey?: string;
      amountYen?: number;
    };
    try {
      return upsertPlannedExpense(db, {
        id,
        name: b.name ?? '',
        category: b.category ?? '',
        cycleDays: Number(b.cycleDays),
        nextDayKey: b.nextDayKey ?? '',
        amountYen: Number(b.amountYen),
      });
    } catch (err) {
      return replyKakeiboError(err, reply);
    }
  });

  app.delete('/api/kakeibo/planned-expenses/:id', async (req) => {
    deletePlannedExpense(db, Number((req.params as { id: string }).id));
    return { ok: true };
  });

  app.post('/api/kakeibo/planned-expenses/:id/record', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const b = (req.body ?? {}) as { dayKey?: string; amountYen?: number; importance?: string };
    try {
      return recordPlannedExpense(db, id, {
        dayKey: b.dayKey ?? todayKey(db),
        amountYen: Number(b.amountYen),
        importance: b.importance ?? 'MUST',
      });
    } catch (err) {
      return replyKakeiboError(err, reply);
    }
  });
}
