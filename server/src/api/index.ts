import type { FastifyInstance } from 'fastify';
import type { DB } from '../db/index.js';
import { getConfig, updateConfig, type AppConfigRow } from '../db/index.js';
import { daySummary, rangeSummary, listGroups, todayKey } from '../services/summary.js';
import {
  listRuleSets,
  getRuleSet,
  upsertFutureRuleSet,
  deleteRuleSet,
  FrozenRuleError,
  type ConditionInput,
} from '../rules/rules.js';
import { evaluateDay } from '../rules/evaluate.js';
import { listChecks, setCheck } from '../rules/checks.js';
import { revealPasswords } from '../password/reveal.js';
import { registerTimelineRoutes } from './timeline.js';
import { registerPlanningRoutes } from './planning.js';
import type { ApiDeps } from './types.js';

export type { ApiDeps };

/** app_config を API 表示用に整形（salt は伏せる）。 */
function publicConfig(cfg: AppConfigRow): Omit<AppConfigRow, 'password_hash_salt'> & {
  hasSalt: boolean;
} {
  const { password_hash_salt, ...rest } = cfg;
  return { ...rest, hasSalt: password_hash_salt.length > 0 };
}

export async function registerApiRoutes(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  const { db } = deps;

  // --- 設定 ---------------------------------------------------------------
  app.get('/api/config', async () => publicConfig(getConfig(db)));

  app.patch('/api/config', async (req) => {
    const body = (req.body ?? {}) as Partial<AppConfigRow>;
    // 更新を許可するフィールドのみ通す。
    const allowed: (keyof AppConfigRow)[] = [
      'tz',
      'day_boundary_minutes',
      'gap_cap_seconds',
      'idle_detection_seconds',
      'heartbeat_seconds',
      'include_ungrouped_in_split',
      'undefined_day_policy',
      'reveal_yesterday',
      'session_coalesce_seconds',
      'away_min_seconds',
      'planning_require_reflection',
      'planning_min_tomorrow_tasks',
      'ws_port' as keyof AppConfigRow,
      'shared_token' as keyof AppConfigRow,
    ];
    const patch: Record<string, unknown> = {};
    for (const k of allowed) if (k in body) patch[k] = body[k];
    updateConfig(db, patch as Partial<AppConfigRow>);
    return publicConfig(getConfig(db));
  });

  // --- グループ（ルール編集のピッカー用）---------------------------------
  app.get('/api/groups', async () => listGroups(db));

  // --- サマリ（ダッシュボード）-------------------------------------------
  app.get('/api/summary', async (req) => {
    const q = req.query as { date?: string };
    const date = q.date ?? todayKey(db);
    return daySummary(db, date);
  });

  app.get('/api/summary/range', async (req, reply) => {
    const q = req.query as { from?: string; to?: string };
    if (!q.from || !q.to) {
      reply.code(400);
      return { error: 'from と to は必須 (YYYY-MM-DD)' };
    }
    return rangeSummary(db, q.from, q.to);
  });

  // --- ルール -------------------------------------------------------------
  app.get('/api/rules', async () => listRuleSets(db));

  app.get('/api/rules/:date', async (req) => {
    const { date } = req.params as { date: string };
    return getRuleSet(db, date) ?? { ruleSet: null, conditions: [] };
  });

  app.put('/api/rules/:date', async (req, reply) => {
    const { date } = req.params as { date: string };
    const b = req.body as { combinator?: 'ALL'; conditions: ConditionInput[] };
    try {
      return upsertFutureRuleSet(db, date, { combinator: b.combinator, conditions: b.conditions ?? [] });
    } catch (err) {
      if (err instanceof FrozenRuleError) {
        reply.code(409);
        return { error: err.message, frozen: true };
      }
      throw err;
    }
  });

  app.delete('/api/rules/:date', async (req, reply) => {
    const { date } = req.params as { date: string };
    try {
      return { deleted: deleteRuleSet(db, date) };
    } catch (err) {
      if (err instanceof FrozenRuleError) {
        reply.code(409);
        return { error: err.message, frozen: true };
      }
      throw err;
    }
  });

  // --- 当日チェック（MANUAL_CHECK）--------------------------------------
  app.get('/api/checks/:date', async (req) => {
    const { date } = req.params as { date: string };
    return listChecks(db, date);
  });

  app.put('/api/checks/:date/:conditionKey', async (req) => {
    const { date, conditionKey } = req.params as { date: string; conditionKey: string };
    const b = (req.body ?? {}) as { checked?: boolean };
    setCheck(db, date, conditionKey, b.checked ?? false);
    const evaluation = evaluateDay(db, date);
    // 達成瞬間の自動 reveal は pipeline 側で扱うため、ここでは評価のみ。
    deps.runPipeline();
    return evaluation;
  });

  // --- アンロック評価 -----------------------------------------------------
  app.get('/api/unlock/:date', async (req) => {
    const { date } = req.params as { date: string };
    return evaluateDay(db, date);
  });

  // --- パスワード reveal（達成時のみ）------------------------------------
  app.post('/api/password/reveal', async (req) => {
    const b = (req.body ?? {}) as { date?: string };
    const date = b.date ?? todayKey(db);
    return revealPasswords(db, date, { auto: false });
  });

  // --- タイムライン / 振り返り・カンバン ---------------------------------
  registerTimelineRoutes(app, deps);
  registerPlanningRoutes(app, deps);
}
