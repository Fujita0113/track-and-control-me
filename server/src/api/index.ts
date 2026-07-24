import type { FastifyInstance } from 'fastify';
import type { DB } from '../db/index.js';
import { getConfig, updateConfig, type AppConfigRow } from '../db/index.js';
import { daySummary, rangeSummary, listGroups, todayKey } from '../services/summary.js';
import { listRecentGroupIdentities } from '../services/group-identity.js';
import { isExtensionOutdated, MIN_EXTENSION_VERSION } from '../services/ext-version.js';
import { evaluateDay } from '../rules/evaluate.js';
import { listChecks, setCheck } from '../rules/checks.js';
import { revealPasswords } from '../password/reveal.js';
import { listManualCategories } from '../services/manual-categories.js';
import { registerTimelineRoutes } from './timeline.js';
import { registerPlanningRoutes } from './planning.js';
import { registerGoalRoutes } from './goals.js';
import { registerDemoRoutes } from './demo.js';
import type { ApiDeps } from './types.js';

export type { ApiDeps };

/** app_config を API 表示用に整形（salt は伏せる）。拡張ビルドの警告フラグも添える（design D7-4）。 */
function publicConfig(
  db: DB,
  cfg: AppConfigRow,
): Omit<AppConfigRow, 'password_hash_salt'> & { hasSalt: boolean; extensionOutdated: boolean; minExtensionVersion: string } {
  const { password_hash_salt, ...rest } = cfg;
  return {
    ...rest,
    hasSalt: password_hash_salt.length > 0,
    extensionOutdated: isExtensionOutdated(db),
    minExtensionVersion: MIN_EXTENSION_VERSION,
  };
}

export async function registerApiRoutes(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  const { db } = deps;

  // --- 設定 ---------------------------------------------------------------
  app.get('/api/config', async () => publicConfig(db, getConfig(db)));

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
      'exclude_ungrouped_from_total',
      'ws_port' as keyof AppConfigRow,
      'shared_token' as keyof AppConfigRow,
    ];
    const patch: Record<string, unknown> = {};
    for (const k of allowed) if (k in body) patch[k] = body[k];
    updateConfig(db, patch as Partial<AppConfigRow>);
    return publicConfig(db, getConfig(db));
  });

  // --- グループ（ルール編集のピッカー用）---------------------------------
  // /api/groups は tab_group（壊れた UUID 行）由来。後方互換のため残すが UI からは使わない。
  app.get('/api/groups', async () => listGroups(db));

  // 直近 N 日に実測された identity 一覧（design D6・spec: group-identity-registry）。
  // 合計時間降順・60秒未満は除外。ルール編集・目標のインライン条件作成のグループ選択肢の源泉。
  app.get('/api/groups/recent', async (req) => {
    const q = req.query as { days?: string };
    const days = q.days ? Number(q.days) : 30;
    return listRecentGroupIdentities(db, Number.isFinite(days) && days > 0 ? days : 30);
  });

  // --- 手動カテゴリ（記録ポップオーバーのチップ; 直近使用順）--------------
  app.get('/api/categories', async () => listManualCategories(db));

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

  // --- ルール（第一級 rule の CRUD は目標コーナー経由・goals.ts / spec: editable-rule-registry）---
  // 今日タブからのルール作成・編集・削除の書き込みエンドポイントは提供しない（spec: editable-rule-registry）。

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

  // --- タイムライン / 振り返り・カンバン / 目標 --------------------------
  registerTimelineRoutes(app, deps);
  registerPlanningRoutes(app, deps);
  registerGoalRoutes(app, deps);

  // --- デモ（お試し）モード: 読み取り専用・本番ゲート非到達（design.md D3）---
  registerDemoRoutes(app, deps);
}
