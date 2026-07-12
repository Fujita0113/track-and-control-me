import type { FastifyInstance } from 'fastify';
import type { ApiDeps } from './types.js';
import { getConfig, type DB } from '../db/index.js';
import { zonedTimeToEpoch, parseDayKey } from '../aggregation/index.js';
import { listGoals, getGoalReport, getJournal, GoalNotFoundError, GoalReportNotReadyError } from '../services/goals.js';
import { daySummary } from '../services/summary.js';
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

  // GET /api/demo/goals/:id/journal/:date — 記入済みサンプル日記。
  app.get('/api/demo/goals/:id/journal/:date', async (req) => {
    const db = getDemoDb();
    const { id, date } = req.params as { id: string; date: string };
    return getJournal(db, Number(id), date);
  });

  // GET /api/demo/today?now=<dayKey> — 仮想日付のサマリ＋ダミーパスワード（reveal は呼ばない）。
  app.get('/api/demo/today', async (req) => {
    const db = getDemoDb();
    const now = resolveNow((req.query as { now?: string }).now);
    const summary = daySummary(db, now);
    // 本物の解禁経路には到達しない。解錠時に見せる値は固定のダミー。
    return { ...summary, virtualDay: now, dummyPassword: 'デモ用 123456' };
  });
}
