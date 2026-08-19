import type { FastifyInstance } from 'fastify';
import type { ApiDeps } from './types.js';
import { todayKey } from '../services/summary.js';
import { monthOf } from '../services/kakeibo-shared.js';
import {
  createEntry,
  updateEntry,
  listEntries,
  suggestNames,
  createBulkEntry,
  declareZeroDay,
  createReceipt,
  getReceiptBytes,
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
  forecastMonth,
  listAdjustRows,
  weeklyRemaining,
  wasteSummary,
  wasteReductionEffect,
} from '../services/kakeibo-forecast.js';
import { importanceBreakdown, categoryTree, weeklyBreakdown } from '../services/kakeibo-analysis.js';

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
    const f = forecastMonth(db, month, today);
    return {
      month,
      today,
      series: f.series,
      landing: {
        landingYen: f.landingYen,
        actualYen: f.actualYen,
        capYen: f.capYen,
        overYen: f.overYen,
        crossDayKey: f.crossDayKey,
        fixedYen: f.fixedYen,
        recent: f.recent,
      },
      summary: {
        dailyAverageYen: f.dailyAverageYen,
        specialYen: f.specialYen,
        plannedYen: f.plannedYen,
        fixedYen: f.fixedYen,
      },
      week: weeklyRemaining(db, today),
      waste: { ...wasteSummary(db, month), effect: wasteReductionEffect(db, month, today) },
      plannedChips: listPlannedExpenses(db, { monthKey: month, fromDayKey: today }),
    };
  });

  app.get('/api/kakeibo/history', async (req) => {
    const month = monthParam(req);
    return { entries: listEntries(db, month) };
  });

  app.get('/api/kakeibo/analysis', async (req) => {
    const month = monthParam(req);
    return {
      importance: importanceBreakdown(db, month),
      tree: categoryTree(db, month),
      weeks: weeklyBreakdown(db, month, todayKey(db)),
    };
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

  // --- 予想の調整モーダル（design D3・D14）-----------------------------------

  app.get('/api/kakeibo/forecast-adjust', async (req) => {
    const month = monthParam(req);
    const today = todayKey(db);
    return { rows: listAdjustRows(db, month, today), effect: forecastMonth(db, month, today) };
  });

  app.post('/api/kakeibo/forecast-adjust/preview', async (req) => {
    const b = (req.body ?? {}) as { month?: string; overrides?: Record<string, boolean> };
    const month = b.month ?? currentMonth();
    const today = todayKey(db);
    return forecastMonth(db, month, today, b.overrides ?? {});
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
        isSpecial: b.isSpecial,
        detail: b.detail ?? null,
        receiptId: b.receiptId ?? null,
      });
    } catch (err) {
      return replyKakeiboError(err, reply);
    }
  });

  app.patch('/api/kakeibo/entries/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const b = (req.body ?? {}) as Record<string, unknown>;
    try {
      return updateEntry(db, id, {
        amountYen: b.amountYen as number | undefined,
        name: b.name as string | undefined,
        category: b.category as string | undefined,
        importance: b.importance as string | null | undefined,
        isSpecial: b.isSpecial as boolean | undefined,
        detail: b.detail as string | null | undefined,
        receiptId: b.receiptId as number | null | undefined,
      });
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
