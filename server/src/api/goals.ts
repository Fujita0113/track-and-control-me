import type { FastifyInstance } from 'fastify';
import type { ApiDeps } from './types.js';
import {
  createGoal,
  listGoals,
  getGoal,
  deleteGoal,
  getGoalReport,
  getJournal,
  saveJournal,
  listJournalImages,
  addJournalImage,
  getJournalImageBytes,
  updateJournalImageCaption,
  deleteJournalImage,
  addRuleToGoal,
  updateGoalRule,
  removeGoalRule,
  continueGoal,
  endGoal,
  submitRulePhoto,
  answerRuleQuestion,
  listDueRules,
  GoalNotFoundError,
  GoalValidationError,
  GoalDeleteWindowError,
  GoalReportNotReadyError,
  JournalNotWritableError,
  JournalImageError,
  JournalImageNotFoundError,
  GoalExtensionRequiredError,
  GoalLifecycleError,
  RuleAnswerError,
  type NewGoalRuleInput,
  type GoalStart,
} from '../services/goals.js';
import { getChronicle } from '../services/goal-chronicle.js';
import {
  RuleNotFoundError,
  ReasonRequiredError,
  RuleValidationError,
  RuleImmutableFieldError,
  type RuleContentInput,
} from '../services/rule-registry.js';
import { todayKey } from '../services/summary.js';
import { evaluateDay } from '../rules/evaluate.js';

/** 開始日クエリ/ボディを today|tomorrow に正規化（既定=today）。 */
function normalizeStart(raw: unknown): GoalStart {
  return raw === 'tomorrow' ? 'tomorrow' : 'today';
}

/**
 * 目標・ルール系のエラーを HTTP へ写す。
 *   404 … 目標・ルールが無い
 *   400 … 入力検証（名前/理由/答えが空・期間外 等）
 *   409 … 状態遷移の不整合（削除猶予切れ・完走前・フォーク決定済み・キャプション変更・拡張要求）
 * 写せない例外は握りつぶさず再送出する（500 として表に出す）。
 */
function replyGoalError(err: unknown, reply: { code: (n: number) => void }): Record<string, unknown> {
  if (err instanceof GoalNotFoundError || err instanceof RuleNotFoundError) {
    reply.code(404);
    return { error: (err as Error).message };
  }
  if (err instanceof GoalExtensionRequiredError) {
    reply.code(409);
    return {
      error: err.message,
      extensionRequired: true,
      proposedEndDay: err.proposedEndDay,
      goalEndDay: err.goalEndDay,
    };
  }
  if (err instanceof GoalReportNotReadyError) {
    reply.code(409);
    return { error: err.message, notReady: true };
  }
  if (
    err instanceof RuleImmutableFieldError ||
    err instanceof GoalLifecycleError ||
    err instanceof GoalDeleteWindowError ||
    err instanceof JournalNotWritableError
  ) {
    reply.code(409);
    return { error: err.message };
  }
  if (err instanceof JournalImageNotFoundError) {
    reply.code(404);
    return { error: err.message };
  }
  if (
    err instanceof GoalValidationError ||
    err instanceof ReasonRequiredError ||
    err instanceof RuleValidationError ||
    err instanceof JournalImageError ||
    err instanceof RuleAnswerError
  ) {
    reply.code(400);
    return { error: err.message };
  }
  throw err;
}

/** 30日チャレンジ API（spec: goal-challenge / goal-journal / goal-report / editable-rule-registry / goal-lifecycle-fork）。 */
export function registerGoalRoutes(app: FastifyInstance, deps: ApiDeps): void {
  const { db } = deps;

  app.get('/api/goals', async () => listGoals(db));

  app.post('/api/goals', async (req, reply) => {
    const b = (req.body ?? {}) as {
      name?: string;
      purpose?: string;
      rules?: NewGoalRuleInput[];
      start?: string;
    };
    try {
      return createGoal(db, {
        name: b.name ?? '',
        purpose: b.purpose,
        rules: b.rules ?? [],
        start: normalizeStart(b.start),
      });
    } catch (err) {
      return replyGoalError(err, reply);
    }
  });

  app.get('/api/goals/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    try {
      return getGoal(db, id);
    } catch (err) {
      return replyGoalError(err, reply);
    }
  });

  app.delete('/api/goals/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    try {
      return { deleted: deleteGoal(db, id) };
    } catch (err) {
      return replyGoalError(err, reply);
    }
  });

  app.get('/api/goals/:id/report', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    try {
      return getGoalReport(db, id);
    } catch (err) {
      return replyGoalError(err, reply);
    }
  });

  // --- 完走フォーク（続ける／終える・spec: goal-lifecycle-fork）-----------

  app.post('/api/goals/:id/continue', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    try {
      return continueGoal(db, id);
    } catch (err) {
      return replyGoalError(err, reply);
    }
  });

  app.post('/api/goals/:id/end', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const b = (req.body ?? {}) as { reason?: string };
    try {
      return endGoal(db, id, b.reason);
    } catch (err) {
      return replyGoalError(err, reply);
    }
  });

  // --- 目標コーナーのルール CRUD（今日タブの書き込み動線は無い・spec: editable-rule-registry）---

  app.post('/api/goals/:id/rules', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const b = (req.body ?? {}) as NewGoalRuleInput & { extend?: 'extend' | 'truncate' };
    try {
      return addRuleToGoal(db, id, b, { extend: b.extend });
    } catch (err) {
      return replyGoalError(err, reply);
    }
  });

  app.patch('/api/goals/:id/rules/:ruleId', async (req, reply) => {
    const id = Number((req.params as { id: string; ruleId: string }).id);
    const ruleId = Number((req.params as { id: string; ruleId: string }).ruleId);
    const b = (req.body ?? {}) as RuleContentInput & { reason: string; extend?: 'extend' | 'truncate' };
    try {
      return updateGoalRule(db, id, ruleId, b, { extend: b.extend });
    } catch (err) {
      return replyGoalError(err, reply);
    }
  });

  app.delete('/api/goals/:id/rules/:ruleId', async (req, reply) => {
    const id = Number((req.params as { id: string; ruleId: string }).id);
    const ruleId = Number((req.params as { id: string; ruleId: string }).ruleId);
    const b = (req.body ?? {}) as { reason?: string };
    try {
      return removeGoalRule(db, id, ruleId, b.reason ?? '');
    } catch (err) {
      return replyGoalError(err, reply);
    }
  });

  // --- ⑤沿革（ルール操作の年表。日記は含まない）----------------------------

  app.get('/api/goals/:id/chronicle', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    try {
      return getChronicle(db, id);
    } catch (err) {
      return replyGoalError(err, reply);
    }
  });

  // --- 日記（spec: goal-journal）-------------------------------------------

  app.get('/api/goals/:id/journal/:date', async (req, reply) => {
    const { id, date } = req.params as { id: string; date: string };
    try {
      getGoal(db, Number(id)); // 存在確認（無ければ 404）。
      return getJournal(db, Number(id), date);
    } catch (err) {
      return replyGoalError(err, reply);
    }
  });

  app.put('/api/goals/:id/journal/:date', async (req, reply) => {
    const { id, date } = req.params as { id: string; date: string };
    const b = (req.body ?? {}) as { content?: string };
    try {
      return saveJournal(db, Number(id), date, b.content ?? '');
    } catch (err) {
      return replyGoalError(err, reply);
    }
  });

  // --- 目標日記の画像添付（spec: goal-journal / D4）------------------------
  // 静的サフィックス /images は :date パラメータ経路より先に評価される（find-my-way は静的優先）。

  app.get('/api/goals/:id/journal/:date/images', async (req, reply) => {
    const { id, date } = req.params as { id: string; date: string };
    try {
      return listJournalImages(db, Number(id), date);
    } catch (err) {
      return replyGoalError(err, reply);
    }
  });

  app.post('/api/goals/:id/journal/:date/images', async (req, reply) => {
    const { id, date } = req.params as { id: string; date: string };
    const b = (req.body ?? {}) as { dataUrl?: string; caption?: string };
    try {
      return addJournalImage(db, Number(id), date, { dataUrl: b.dataUrl ?? '', caption: b.caption });
    } catch (err) {
      return replyGoalError(err, reply);
    }
  });

  app.get('/api/goals/:id/journal/images/:imageId', async (req, reply) => {
    const { id, imageId } = req.params as { id: string; imageId: string };
    try {
      const { mime, bytes } = getJournalImageBytes(db, Number(id), Number(imageId));
      reply.header('Cache-Control', 'private, max-age=31536000, immutable');
      reply.header('Content-Length', bytes.length);
      return reply.type(mime).send(bytes);
    } catch (err) {
      return replyGoalError(err, reply);
    }
  });

  app.patch('/api/goals/:id/journal/images/:imageId', async (req, reply) => {
    const { id, imageId } = req.params as { id: string; imageId: string };
    const b = (req.body ?? {}) as { caption?: string };
    try {
      return updateJournalImageCaption(db, Number(id), Number(imageId), b.caption ?? '');
    } catch (err) {
      return replyGoalError(err, reply);
    }
  });

  app.delete('/api/goals/:id/journal/images/:imageId', async (req, reply) => {
    const { id, imageId } = req.params as { id: string; imageId: string };
    try {
      return { deleted: deleteJournalImage(db, Number(id), Number(imageId)) };
    } catch (err) {
      return replyGoalError(err, reply);
    }
  });

  // --- 写真/質問ルールへの回答（今日タブの不足条件・spec: goal-check-gate）-------

  // その日に回答すべきルール（今日タブの不足条件・初回トースト）。
  app.get('/api/due-rules/:date', async (req) => {
    const { date } = req.params as { date: string };
    return { dayKey: date, rules: listDueRules(db, date) };
  });

  app.post('/api/rules/:ruleId/photo', async (req, reply) => {
    const ruleId = Number((req.params as { ruleId: string }).ruleId);
    const b = (req.body ?? {}) as { date?: string; dataUrl?: string; width?: number; height?: number };
    const date = b.date ?? todayKey(db);
    try {
      const out = submitRulePhoto(db, ruleId, date, { dataUrl: b.dataUrl ?? '', width: b.width, height: b.height });
      evaluateDay(db, date);
      deps.runPipeline();
      return out;
    } catch (err) {
      return replyGoalError(err, reply);
    }
  });

  app.post('/api/rules/:ruleId/answer', async (req, reply) => {
    const ruleId = Number((req.params as { ruleId: string }).ruleId);
    const b = (req.body ?? {}) as { date?: string; answerText?: string };
    const date = b.date ?? todayKey(db);
    try {
      const out = answerRuleQuestion(db, ruleId, date, b.answerText ?? '');
      evaluateDay(db, date);
      deps.runPipeline();
      return out;
    } catch (err) {
      return replyGoalError(err, reply);
    }
  });
}
