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
  cancelEndGoal,
  submitRulePhoto,
  answerRuleQuestion,
  listDueRules,
  GoalNotFoundError,
  GoalValidationError,
  GoalDeleteWindowError,
  GoalDeleteAfterEndError,
  GoalReportNotReadyError,
  JournalNotWritableError,
  JournalImageError,
  JournalImageNotFoundError,
  GoalExtensionRequiredError,
  GoalLifecycleError,
  RuleAnswerError,
  type NewGoalRuleInput,
  type NewGoalTargetHoursInput,
  type GoalStart,
} from '../services/goals.js';
import { goalHistory } from '../services/goal-history.js';
import { getBlueprint, importBlueprint, computeOpenPath, createRootTask, TaskTreeError } from '../services/task-tree.js';
import {
  reserveFreeze,
  reserveFreezeMulti,
  sameDayFreeze,
  sameDayFreezeMulti,
  updateFreeze,
  cancelFreeze,
  releaseFreeze,
  freezeQuota,
  sameDayFreezeQuota,
  FreezeValidationError,
  FreezeStateError,
} from '../services/goal-freeze.js';
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
    err instanceof GoalDeleteAfterEndError ||
    err instanceof JournalNotWritableError ||
    err instanceof FreezeStateError
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
    err instanceof RuleAnswerError ||
    err instanceof FreezeValidationError
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
      startReason?: string;
      endDay?: string;
      rules?: NewGoalRuleInput[];
      start?: string;
      targetHours?: NewGoalTargetHoursInput | null;
      outcomeCaption?: string | null;
      outcomeImage?: { dataUrl: string } | null;
    };
    try {
      return createGoal(db, {
        name: b.name ?? '',
        purpose: b.purpose ?? '',
        startReason: b.startReason ?? '',
        endDay: b.endDay ?? '',
        rules: b.rules ?? [],
        start: normalizeStart(b.start),
        targetHours: b.targetHours ?? null,
        outcomeCaption: b.outcomeCaption ?? null,
        outcomeImage: b.outcomeImage ?? null,
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

  // --- 設計図（目標単位のタスクツリー・spec: goal-blueprint）---------------

  app.get('/api/goals/:id/blueprint', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    try {
      getGoal(db, id); // 存在確認（無ければ 404）。
      const blueprint = getBlueprint(db, id);
      return { nodes: blueprint.nodes, openPath: computeOpenPath(blueprint.nodes) };
    } catch (err) {
      return replyGoalError(err, reply);
    }
  });

  // 根に1件だけ足す（タスク一覧の「＋ 新しい枝を足す」・task-list-inline-edit design D9）。
  app.post('/api/goals/:id/blueprint/root', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const b = (req.body ?? {}) as { title?: string };
    try {
      getGoal(db, id); // 存在確認（無ければ 404）。
      if (!b.title || !b.title.trim()) {
        reply.code(400);
        return { error: 'title は必須' };
      }
      const task = createRootTask(db, id, b.title.trim());
      deps.runPipeline();
      return task;
    } catch (err) {
      return replyGoalError(err, reply);
    }
  });

  app.post('/api/goals/:id/blueprint/import', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const b = (req.body ?? {}) as { text?: string; parentTaskId?: number | null };
    try {
      getGoal(db, id); // 存在確認（無ければ 404）。
      importBlueprint(db, id, b.text ?? '', b.parentTaskId ?? null);
      deps.runPipeline();
      const blueprint = getBlueprint(db, id);
      return { nodes: blueprint.nodes, openPath: computeOpenPath(blueprint.nodes) };
    } catch (err) {
      if (err instanceof TaskTreeError) {
        reply.code(400);
        return { error: err.message };
      }
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
    const b = (req.body ?? {}) as {
      reason?: string;
      outcomeMet?: boolean;
      photo?: { dataUrl: string; width?: number | null; height?: number | null };
    };
    try {
      return endGoal(db, id, { reason: b.reason ?? '', outcomeMet: b.outcomeMet, photo: b.photo });
    } catch (err) {
      return replyGoalError(err, reply);
    }
  });

  // 終了は翌日発効なので、発効前（today < ended_day_key）は取り消せる（spec: goal-lifecycle-fork）。
  app.post('/api/goals/:id/end/cancel', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    try {
      return cancelEndGoal(db, id);
    } catch (err) {
      return replyGoalError(err, reply);
    }
  });

  // --- 大きい沿革（目標の年表・spec: goal-history）--------------------------

  app.get('/api/goals/history', async () => goalHistory(db));

  // --- 一時凍結（spec: goal-freeze）-----------------------------------------
  // 静的パス /api/goals/freeze/quota は /api/goals/:id 系と衝突しない（find-my-way は静的優先）。

  // 期間凍結の枠（発効日＝翌日の月）に、当日凍結の枠（today の月）を `sameDay` として添える。
  // 月末は両者が違う月を指すため、モーダルは選択中の種別に対応するほうを出す（design D4）。
  app.get('/api/goals/freeze/quota', async () => ({ ...freezeQuota(db), sameDay: sameDayFreezeQuota(db) }));

  app.post('/api/goals/freeze/multi', async (req, reply) => {
    const b = (req.body ?? {}) as { goalIds?: number[]; endDay?: string; reason?: string };
    try {
      return reserveFreezeMulti(db, b.goalIds ?? [], { endDay: b.endDay ?? '', reason: b.reason ?? '' });
    } catch (err) {
      return replyGoalError(err, reply);
    }
  });

  // 当日凍結（今日1日だけ・期限は受け取らない・spec: goal-freeze ADDED）。
  app.post('/api/goals/freeze/same-day/multi', async (req, reply) => {
    const b = (req.body ?? {}) as { goalIds?: number[]; reason?: string };
    try {
      return sameDayFreezeMulti(db, b.goalIds ?? [], { reason: b.reason ?? '' });
    } catch (err) {
      return replyGoalError(err, reply);
    }
  });

  app.post('/api/goals/:id/freeze/same-day', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const b = (req.body ?? {}) as { reason?: string };
    try {
      return sameDayFreeze(db, id, { reason: b.reason ?? '' });
    } catch (err) {
      return replyGoalError(err, reply);
    }
  });

  app.post('/api/goals/:id/freeze', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const b = (req.body ?? {}) as { endDay?: string; reason?: string };
    try {
      return reserveFreeze(db, id, { endDay: b.endDay ?? '', reason: b.reason ?? '' });
    } catch (err) {
      return replyGoalError(err, reply);
    }
  });

  app.patch('/api/goals/:id/freeze', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const b = (req.body ?? {}) as { endDay?: string; reason?: string };
    try {
      return updateFreeze(db, id, { endDay: b.endDay ?? '', reason: b.reason ?? '' });
    } catch (err) {
      return replyGoalError(err, reply);
    }
  });

  app.delete('/api/goals/:id/freeze', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    try {
      return { canceled: cancelFreeze(db, id) };
    } catch (err) {
      return replyGoalError(err, reply);
    }
  });

  app.post('/api/goals/:id/freeze/release', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    try {
      return releaseFreeze(db, id);
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
      return getChronicle(db, id, todayKey(db, Date.now()));
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
