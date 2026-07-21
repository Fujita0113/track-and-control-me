import type { FastifyInstance } from 'fastify';
import type { ApiDeps } from './types.js';
import {
  adoptCandidates,
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
  GoalNotFoundError,
  GoalPracticeError,
  GoalDeleteWindowError,
  GoalReportNotReadyError,
  JournalNotWritableError,
  JournalImageError,
  JournalImageNotFoundError,
  type NewInlineCondition,
  type GoalStart,
} from '../services/goals.js';
import {
  createPlan,
  createCheck,
  listPlans,
  getChronicle,
  withdrawPlan,
  cancelCheck,
  updateCheckCaption,
  submitPhoto,
  answerQuestion,
  listDueChecks,
  PlanCheckError,
  PlanNotFoundError,
  CheckNotFoundError,
  CheckImmutableError,
} from '../services/goal-plan-check.js';
import { todayKey } from '../services/summary.js';
import { evaluateDay } from '../rules/evaluate.js';
import { GoalLockError, ThresholdReasonRequiredError, BaselineViolationError, FrozenRuleError } from '../rules/rules.js';

/** 開始日クエリ/ボディを today|tomorrow に正規化（既定=today）。 */
function normalizeStart(raw: unknown): GoalStart {
  return raw === 'tomorrow' ? 'tomorrow' : 'today';
}

/**
 * Plan / Check 系のエラーを HTTP へ写す。
 *   404 … 目標・Plan・Check が無い
 *   400 … 入力検証（本文/理由/答えが空・範囲2日未満・期間外 等）・画像検証
 *   409 … 作成後に変更できない項目（写真Check のキャプション）
 * 写せない例外は握りつぶさず再送出する（500 として表に出す）。
 */
function replyPlanCheckError(err: unknown, reply: { code: (n: number) => void }): { error: string } {
  if (err instanceof GoalNotFoundError || err instanceof PlanNotFoundError || err instanceof CheckNotFoundError) {
    reply.code(404);
    return { error: (err as Error).message };
  }
  if (err instanceof CheckImmutableError) {
    reply.code(409);
    return { error: err.message };
  }
  if (err instanceof PlanCheckError || err instanceof JournalImageError) {
    reply.code(400);
    return { error: err.message };
  }
  throw err;
}

/** 30日チャレンジ API（spec: goal-challenge / goal-journal / goal-report）。 */
export function registerGoalRoutes(app: FastifyInstance, deps: ApiDeps): void {
  const { db } = deps;

  // 採用候補（開始日の実効ルール）。:id より先に定義する（静的セグメント優先の明示）。
  // ?start=today|tomorrow で解決元を切替（既定=today）。
  app.get('/api/goals/candidates', async (req) =>
    adoptCandidates(db, undefined, normalizeStart((req.query as { start?: string }).start)),
  );

  app.get('/api/goals', async () => listGoals(db));

  app.post('/api/goals', async (req, reply) => {
    const b = (req.body ?? {}) as {
      name?: string;
      purpose?: string;
      practices?: string[];
      newConditions?: NewInlineCondition[];
      start?: string;
    };
    try {
      return createGoal(db, {
        name: b.name ?? '',
        purpose: b.purpose,
        practices: b.practices ?? [],
        newConditions: b.newConditions ?? [],
        start: normalizeStart(b.start),
      });
    } catch (err) {
      // バリデーション・閾値理由必須・baseline 違反は 400、凍結・ジャンル固定は 409。
      // BaselineViolationError は FrozenRuleError の派生なので先に判定する。
      if (
        err instanceof GoalPracticeError ||
        err instanceof ThresholdReasonRequiredError ||
        err instanceof BaselineViolationError
      ) {
        reply.code(400);
        return { error: err.message };
      }
      if (err instanceof GoalLockError || err instanceof FrozenRuleError) {
        reply.code(409);
        return { error: err.message };
      }
      throw err;
    }
  });

  app.get('/api/goals/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    try {
      return getGoal(db, id);
    } catch (err) {
      if (err instanceof GoalNotFoundError) {
        reply.code(404);
        return { error: err.message };
      }
      throw err;
    }
  });

  app.delete('/api/goals/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    try {
      return { deleted: deleteGoal(db, id) };
    } catch (err) {
      if (err instanceof GoalNotFoundError) {
        reply.code(404);
        return { error: err.message };
      }
      if (err instanceof GoalDeleteWindowError) {
        reply.code(409);
        return { error: err.message };
      }
      throw err;
    }
  });

  app.get('/api/goals/:id/report', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    try {
      return getGoalReport(db, id);
    } catch (err) {
      if (err instanceof GoalNotFoundError) {
        reply.code(404);
        return { error: err.message };
      }
      if (err instanceof GoalReportNotReadyError) {
        reply.code(409);
        return { error: err.message, notReady: true };
      }
      throw err;
    }
  });

  app.get('/api/goals/:id/journal/:date', async (req, reply) => {
    const { id, date } = req.params as { id: string; date: string };
    try {
      getGoal(db, Number(id)); // 存在確認（無ければ 404）。
      return getJournal(db, Number(id), date);
    } catch (err) {
      if (err instanceof GoalNotFoundError) {
        reply.code(404);
        return { error: err.message };
      }
      throw err;
    }
  });

  app.put('/api/goals/:id/journal/:date', async (req, reply) => {
    const { id, date } = req.params as { id: string; date: string };
    const b = (req.body ?? {}) as { content?: string };
    try {
      return saveJournal(db, Number(id), date, b.content ?? '');
    } catch (err) {
      if (err instanceof GoalNotFoundError) {
        reply.code(404);
        return { error: err.message };
      }
      if (err instanceof JournalNotWritableError) {
        reply.code(409);
        return { error: err.message };
      }
      throw err;
    }
  });

  // --- 目標日記の画像添付（spec: goal-journal / D4）------------------------
  // 静的サフィックス /images は :date パラメータ経路より先に評価される（find-my-way は静的優先）。

  // その日の画像メタ一覧（バイトは含めない）。
  app.get('/api/goals/:id/journal/:date/images', async (req, reply) => {
    const { id, date } = req.params as { id: string; date: string };
    try {
      return listJournalImages(db, Number(id), date);
    } catch (err) {
      if (err instanceof GoalNotFoundError) {
        reply.code(404);
        return { error: err.message };
      }
      throw err;
    }
  });

  // 画像を追加（JSON { dataUrl, caption? }）。状態は問わず追加可、検証失敗（期間外/非画像/上限超過）は 400。
  app.post('/api/goals/:id/journal/:date/images', async (req, reply) => {
    const { id, date } = req.params as { id: string; date: string };
    const b = (req.body ?? {}) as { dataUrl?: string; caption?: string };
    try {
      return addJournalImage(db, Number(id), date, { dataUrl: b.dataUrl ?? '', caption: b.caption });
    } catch (err) {
      if (err instanceof GoalNotFoundError) {
        reply.code(404);
        return { error: err.message };
      }
      if (err instanceof JournalImageError) {
        reply.code(400);
        return { error: err.message };
      }
      throw err;
    }
  });

  // 画像バイナリ（Content-Type=mime・キャッシュ可）。読み取りは status 非依存。
  app.get('/api/goals/:id/journal/images/:imageId', async (req, reply) => {
    const { id, imageId } = req.params as { id: string; imageId: string };
    try {
      const { mime, bytes } = getJournalImageBytes(db, Number(id), Number(imageId));
      reply.header('Cache-Control', 'private, max-age=31536000, immutable');
      reply.header('Content-Length', bytes.length);
      return reply.type(mime).send(bytes);
    } catch (err) {
      if (err instanceof GoalNotFoundError || err instanceof JournalImageNotFoundError) {
        reply.code(404);
        return { error: err.message };
      }
      throw err;
    }
  });

  // キャプション更新（所有検証のみ・状態は問わない）。
  app.patch('/api/goals/:id/journal/images/:imageId', async (req, reply) => {
    const { id, imageId } = req.params as { id: string; imageId: string };
    const b = (req.body ?? {}) as { caption?: string };
    try {
      return updateJournalImageCaption(db, Number(id), Number(imageId), b.caption ?? '');
    } catch (err) {
      if (err instanceof GoalNotFoundError || err instanceof JournalImageNotFoundError) {
        reply.code(404);
        return { error: err.message };
      }
      throw err;
    }
  });

  // 画像削除（所有検証のみ・状態は問わない）。
  app.delete('/api/goals/:id/journal/images/:imageId', async (req, reply) => {
    const { id, imageId } = req.params as { id: string; imageId: string };
    try {
      return { deleted: deleteJournalImage(db, Number(id), Number(imageId)) };
    } catch (err) {
      if (err instanceof GoalNotFoundError || err instanceof JournalImageNotFoundError) {
        reply.code(404);
        return { error: err.message };
      }
      throw err;
    }
  });

  // --- Plan / Check（spec: goal-plan-check / goal-check-gate / goal-chronicle）-------
  // 既存の `/api/checks/:date`（MANUAL_CHECK）と衝突しないよう `/api/goal-checks/*` に分ける。

  // Plan 一覧（振り返りタブの目標コーナー）。
  app.get('/api/goals/:id/plans', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    try {
      return listPlans(db, id);
    } catch (err) {
      return replyPlanCheckError(err, reply);
    }
  });

  // Plan 作成（進行中の目標のみ・本文非空・種別なし）。
  app.post('/api/goals/:id/plans', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    try {
      return createPlan(db, id, req.body ?? {});
    } catch (err) {
      return replyPlanCheckError(err, reply);
    }
  });

  // ⑤沿革（Plan＋Check＋回答の入れ子。日記は含まない）。
  app.get('/api/goals/:id/chronicle', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    try {
      return getChronicle(db, id);
    } catch (err) {
      return replyPlanCheckError(err, reply);
    }
  });

  // Plan へ Check を追加（種類×いつ の2軸。相対・絶対どちらの「いつ」も受ける）。
  app.post('/api/goals/plans/:planId/checks', async (req, reply) => {
    const planId = Number((req.params as { planId: string }).planId);
    try {
      return createCheck(db, planId, req.body ?? {});
    } catch (err) {
      return replyPlanCheckError(err, reply);
    }
  });

  // Plan の取り下げ（理由必須。配下の未達 Check も外れる）。ゲートが緩む向きなので再評価する。
  app.post('/api/goals/plans/:planId/withdraw', async (req, reply) => {
    const planId = Number((req.params as { planId: string }).planId);
    try {
      const out = withdrawPlan(db, planId, req.body ?? {});
      evaluateDay(db, todayKey(db));
      deps.runPipeline();
      return out;
    } catch (err) {
      return replyPlanCheckError(err, reply);
    }
  });

  // その日に回答すべき Check（今日タブの不足条件・初回トースト）。静的 `due` を :checkId より先に置く。
  app.get('/api/goal-checks/due/:date', async (req) => {
    const { date } = req.params as { date: string };
    return { dayKey: date, checks: listDueChecks(db, date) };
  });

  // 写真Check への提出（キャプションは先指定のため受け取らない）。提出でゲートが開きうる。
  app.post('/api/goal-checks/:checkId/photo', async (req, reply) => {
    const checkId = Number((req.params as { checkId: string }).checkId);
    const b = (req.body ?? {}) as { date?: string };
    const date = b.date ?? todayKey(db);
    try {
      const out = submitPhoto(db, checkId, date, req.body ?? {});
      evaluateDay(db, date);
      deps.runPipeline();
      return out;
    } catch (err) {
      return replyPlanCheckError(err, reply);
    }
  });

  // 質問Check への回答（空回答は 400）。回答でゲートが開きうる。
  app.post('/api/goal-checks/:checkId/answer', async (req, reply) => {
    const checkId = Number((req.params as { checkId: string }).checkId);
    const b = (req.body ?? {}) as { date?: string };
    const date = b.date ?? todayKey(db);
    try {
      const out = answerQuestion(db, checkId, date, req.body ?? {});
      evaluateDay(db, date);
      deps.runPipeline();
      return out;
    } catch (err) {
      return replyPlanCheckError(err, reply);
    }
  });

  // Check の取り下げ（理由必須・達成済みは拒否）。外れるとゲートが開きうる。
  app.post('/api/goal-checks/:checkId/cancel', async (req, reply) => {
    const checkId = Number((req.params as { checkId: string }).checkId);
    try {
      const out = cancelCheck(db, checkId, req.body ?? {});
      evaluateDay(db, todayKey(db));
      deps.runPipeline();
      return out;
    } catch (err) {
      return replyPlanCheckError(err, reply);
    }
  });

  // 写真Check のキャプションは作成後に変更できない（常に 409）。③のグループ化キーを決定的に保つため。
  app.patch('/api/goal-checks/:checkId/caption', async (req, reply) => {
    const checkId = Number((req.params as { checkId: string }).checkId);
    const b = (req.body ?? {}) as { caption?: string };
    try {
      return updateCheckCaption(db, checkId, b.caption ?? '');
    } catch (err) {
      return replyPlanCheckError(err, reply);
    }
  });
}
