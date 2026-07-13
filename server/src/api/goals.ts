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
import { GoalLockError, ThresholdReasonRequiredError, BaselineViolationError, FrozenRuleError } from '../rules/rules.js';

/** 開始日クエリ/ボディを today|tomorrow に正規化（既定=today）。 */
function normalizeStart(raw: unknown): GoalStart {
  return raw === 'tomorrow' ? 'tomorrow' : 'today';
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
}
