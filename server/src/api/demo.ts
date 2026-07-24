import type { FastifyInstance } from 'fastify';
import type { ApiDeps } from './types.js';
import { getConfig, type DB } from '../db/index.js';
import { zonedTimeToEpoch, parseDayKey } from '../aggregation/index.js';
import {
  listGoals,
  getGoal,
  getGoalReport,
  getJournal,
  getJournalImageBytes,
  addRuleToGoal,
  updateGoalRule,
  removeGoalRule,
  continueGoal,
  endGoal,
  listDueRules,
  GoalNotFoundError,
  GoalReportNotReadyError,
  GoalExtensionRequiredError,
  GoalLifecycleError,
  JournalImageNotFoundError,
} from '../services/goals.js';
import {
  RuleNotFoundError,
  ReasonRequiredError,
  RuleValidationError,
} from '../services/rule-registry.js';
import { getChronicle } from '../services/goal-chronicle.js';
import { daySummary } from '../services/summary.js';
import { getDayAllocation } from '../services/day-allocation.js';
import { getDemoDb, resetDemoDb } from '../services/demo-db.js';
import {
  DEMO_START_DAY,
  DEMO_END_DAY,
  DEMO_PRE_START_DAY,
  DEMO_AFTER_END_DAY,
} from '../services/demo-seed.js';

/**
 * デモ（お試し）モードの読み取り専用ルータ（spec: demo-mode / design.md D3）。
 * デモ DB のみを参照し、本物の解禁処理・パスワード生成コマンド・本番 DB 書き込み関数の
 * いずれも import しない（呼び出しグラフ上で本番ゲートに到達しない）。今日タブのパスワードは
 * ダミー値を返すだけで、本物の解禁関数は一切呼ばない。
 *
 * 仮想「今日」はクライアント所有（`?now=<dayKey>`）。サーバは受け取った仮想 day_key を
 * デモ config（tz・境界）で `nowMs` に変換し、既存サービスをデモ DB＋仮想 now で呼ぶ（D2）。
 */

const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 仮想 day_key（正午）を epoch ms へ。境界（04:00）内に確実に収まる正午を使う。 */
function virtualNowMs(db: DB, dayKey: string): number {
  const cfg = getConfig(db);
  const { year, month, day } = parseDayKey(dayKey);
  return zonedTimeToEpoch(year, month, day, 12, 0, 0, cfg.tz);
}

/** クエリの仮想 day_key を検証。未指定/不正は開始前（start − 1）に落とす。 */
function resolveNow(raw: unknown): string {
  return typeof raw === 'string' && DAY_KEY_RE.test(raw) ? raw : DEMO_PRE_START_DAY;
}

const DEMO_META = {
  startDay: DEMO_START_DAY,
  endDay: DEMO_END_DAY,
  preStartDay: DEMO_PRE_START_DAY,
  afterEndDay: DEMO_AFTER_END_DAY,
};

export function registerDemoRoutes(app: FastifyInstance, _deps: ApiDeps): void {
  // POST /api/demo/reset — デモ DB を再 seed し、初期仮想 day_key（開始前）と目標概要を返す。
  app.post('/api/demo/reset', async () => {
    const db = resetDemoDb();
    const virtualDay = DEMO_PRE_START_DAY;
    const goals = listGoals(db, virtualNowMs(db, virtualDay));
    return { ...DEMO_META, virtualDay, goal: goals[0] ?? null, goals };
  });

  // GET /api/demo/goals?now=<dayKey> — 仮想日付での目標一覧（導出状態つき）。
  app.get('/api/demo/goals', async (req) => {
    const db = getDemoDb();
    const now = resolveNow((req.query as { now?: string }).now);
    return { ...DEMO_META, virtualDay: now, goals: listGoals(db, virtualNowMs(db, now)) };
  });

  // GET /api/demo/goals/:id?now=<dayKey> — 目標1件（導出状態つき）。
  app.get('/api/demo/goals/:id', async (req, reply) => {
    const db = getDemoDb();
    const id = Number((req.params as { id: string }).id);
    const now = resolveNow((req.query as { now?: string }).now);
    try {
      return getGoal(db, id, virtualNowMs(db, now));
    } catch (err) {
      if (err instanceof GoalNotFoundError) {
        reply.code(404);
        return { error: err.message };
      }
      throw err;
    }
  });

  // GET /api/demo/goals/:id/chronicle — ⑤沿革（デモ DB・読み取り専用）。
  app.get('/api/demo/goals/:id/chronicle', async (req, reply) => {
    const db = getDemoDb();
    const id = Number((req.params as { id: string }).id);
    try {
      return getChronicle(db, id);
    } catch (err) {
      if (err instanceof GoalNotFoundError) {
        reply.code(404);
        return { error: err.message };
      }
      throw err;
    }
  });

  // GET /api/demo/goals/:id/report?now=<dayKey> — 完走レポート4ブロック。
  app.get('/api/demo/goals/:id/report', async (req, reply) => {
    const db = getDemoDb();
    const id = Number((req.params as { id: string }).id);
    const now = resolveNow((req.query as { now?: string }).now);
    try {
      return getGoalReport(db, id, virtualNowMs(db, now));
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

  // GET /api/demo/goals/:id/journal/images/:imageId — サンプル画像バイナリ（:date より先に定義）。
  app.get('/api/demo/goals/:id/journal/images/:imageId', async (req, reply) => {
    const db = getDemoDb();
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

  // GET /api/demo/goals/:id/journal/:date — 記入済みサンプル日記。
  app.get('/api/demo/goals/:id/journal/:date', async (req) => {
    const db = getDemoDb();
    const { id, date } = req.params as { id: string; date: string };
    return getJournal(db, Number(id), date);
  });

  // GET /api/demo/timeline/:date/allocation — 仮想日付の一日の配分（デモ DB・読み取り専用）。
  // 本番ルート（/api/timeline/:date/allocation）と同じ集計だが、参照先はデモ DB＋仮想 now。
  app.get('/api/demo/timeline/:date/allocation', async (req) => {
    const db = getDemoDb();
    const { date } = req.params as { date: string };
    return getDayAllocation(db, date, virtualNowMs(db, date));
  });

  // GET /api/demo/today?now=<dayKey> — 仮想日付のサマリ＋ダミーパスワード（reveal は呼ばない）。
  app.get('/api/demo/today', async (req) => {
    const db = getDemoDb();
    const now = resolveNow((req.query as { now?: string }).now);
    const summary = daySummary(db, now);
    // 本物の解禁経路には到達しない。解錠時に見せる値は固定のダミー。
    return { ...summary, virtualDay: now, dummyPassword: 'デモ用 123456' };
  });

  // GET /api/demo/due-rules?now=<dayKey> — 仮想日付の不足ルール（単発ルール通知チュートリアル）。
  app.get('/api/demo/due-rules', async (req) => {
    const db = getDemoDb();
    const now = resolveNow((req.query as { now?: string }).now);
    return { dayKey: now, rules: listDueRules(db, now) };
  });

  /**
   * デモの2つのチュートリアル（spec: demo-rule-tutorial）だけは、デモ DB への書き込みを許す。
   * ルール登録・完走フォークの関数をデモ DB（getDemoDb()）に対して呼ぶだけで、本番 DB・reveal・
   * パスワード生成・目標本体の作成/削除/日記保存には一切触れない（design D8）。
   */
  function replyDemoError(err: unknown, reply: { code: (n: number) => void }): Record<string, unknown> {
    if (err instanceof GoalNotFoundError || err instanceof RuleNotFoundError) {
      reply.code(404);
      return { error: (err as Error).message };
    }
    if (err instanceof GoalExtensionRequiredError) {
      reply.code(409);
      return { error: err.message, extensionRequired: true, proposedEndDay: err.proposedEndDay, goalEndDay: err.goalEndDay };
    }
    if (err instanceof GoalLifecycleError) {
      reply.code(409);
      return { error: err.message };
    }
    if (err instanceof ReasonRequiredError || err instanceof RuleValidationError) {
      reply.code(400);
      return { error: err.message };
    }
    throw err;
  }

  // POST /api/demo/goals/:id/rules — 振り返りタブでの単発ルール作成チュートリアル用（デモ DB のみ）。
  app.post('/api/demo/goals/:id/rules', async (req, reply) => {
    const db = getDemoDb();
    const id = Number((req.params as { id: string }).id);
    const now = resolveNow((req.body as { now?: string })?.now);
    const b = (req.body ?? {}) as Record<string, unknown> & { extend?: 'extend' | 'truncate' };
    try {
      return addRuleToGoal(db, id, b as never, { extend: b.extend }, virtualNowMs(db, now));
    } catch (err) {
      return replyDemoError(err, reply);
    }
  });

  // PATCH /api/demo/goals/:id/rules/:ruleId — ルール編集（デモ DB のみ）。
  app.patch('/api/demo/goals/:id/rules/:ruleId', async (req, reply) => {
    const db = getDemoDb();
    const { id, ruleId } = req.params as { id: string; ruleId: string };
    const b = (req.body ?? {}) as Record<string, unknown> & { extend?: 'extend' | 'truncate'; now?: string };
    const now = resolveNow(b.now);
    try {
      return updateGoalRule(db, Number(id), Number(ruleId), b as never, { extend: b.extend }, virtualNowMs(db, now));
    } catch (err) {
      return replyDemoError(err, reply);
    }
  });

  // DELETE /api/demo/goals/:id/rules/:ruleId — ルール削除（デモ DB のみ）。
  app.delete('/api/demo/goals/:id/rules/:ruleId', async (req, reply) => {
    const db = getDemoDb();
    const { id, ruleId } = req.params as { id: string; ruleId: string };
    const b = (req.body ?? {}) as { reason?: string; now?: string };
    const now = resolveNow(b.now);
    try {
      return removeGoalRule(db, Number(id), Number(ruleId), b.reason ?? '', virtualNowMs(db, now));
    } catch (err) {
      return replyDemoError(err, reply);
    }
  });

  // POST /api/demo/goals/:id/continue — 完走フォーク「続ける」チュートリアル用（デモ DB のみ）。
  app.post('/api/demo/goals/:id/continue', async (req, reply) => {
    const db = getDemoDb();
    const id = Number((req.params as { id: string }).id);
    const now = resolveNow((req.body as { now?: string })?.now);
    try {
      return continueGoal(db, id, virtualNowMs(db, now));
    } catch (err) {
      return replyDemoError(err, reply);
    }
  });

  // POST /api/demo/goals/:id/end — 完走フォーク「終える」チュートリアル用（デモ DB のみ）。
  app.post('/api/demo/goals/:id/end', async (req, reply) => {
    const db = getDemoDb();
    const id = Number((req.params as { id: string }).id);
    const b = (req.body ?? {}) as { reason?: string; now?: string };
    const now = resolveNow(b.now);
    try {
      return endGoal(db, id, b.reason, virtualNowMs(db, now));
    } catch (err) {
      return replyDemoError(err, reply);
    }
  });
}
