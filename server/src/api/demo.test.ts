import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { openDb, getConfig, type DB } from '../db/index.js';
import { registerApiRoutes } from './index.js';
import { resetDemoDb } from '../services/demo-db.js';

/**
 * ガードレール受け入れ（tasks 5.3 / spec: 本番非干渉）。
 * デモを「完走へ」まで進め、解錠済みのダミーパスワードまで確認した後でも、
 * 本番 `POST /api/password/reveal` の出力が操作前と不変で、本番の目標・設定が無傷であること。
 * デモ経路は本番 DB のコネクションに一度も触れない（別インメモリ DB の専用ルータ）。
 */

const REVEAL_DATE = '2026-07-15';
const DEMO_ACHIEVED_DAY = '2026-06-16'; // Day6（全条件 met = 解錠済み）
const DEMO_COMPLETED_DAY = '2026-07-11'; // end + 1（完走）

let app: FastifyInstance;
let db: DB;

beforeEach(async () => {
  db = openDb(':memory:'); // 本番 DB（空）。
  resetDemoDb(); // デモ DB を初期状態へ。
  app = Fastify();
  await registerApiRoutes(app, { db, runPipeline: () => {} });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  db.close();
});

async function injectJson(method: 'GET' | 'POST', url: string, payload?: unknown) {
  const res = await app.inject({ method, url, payload: payload as object | undefined });
  return { status: res.statusCode, body: JSON.parse(res.body) as Record<string, unknown> };
}

describe('デモ操作後も本番 reveal・本番データが不変（5.3）', () => {
  it('未来へ飛ばして完走→ダミーPWを見ても、本番 reveal の出力は操作前と同一', async () => {
    // --- 操作前スナップショット ---
    const revealBefore = await injectJson('POST', '/api/password/reveal', { date: REVEAL_DATE });
    expect(revealBefore.body.unlocked).toBe(false); // 空の本番 DB は未達成（脱出弁なし）。
    const goalsBefore = await injectJson('GET', '/api/goals');
    const cfgBefore = getConfig(db);

    // --- デモ操作: リセット→完走→解錠済みの日でダミーPW確認 ---
    const reset = await injectJson('POST', '/api/demo/reset');
    expect(reset.status).toBe(200);
    expect(reset.body.virtualDay).toBe('2026-06-10'); // 開始前（start − 1）。

    const completed = await injectJson('GET', `/api/demo/goals?now=${DEMO_COMPLETED_DAY}`);
    const demoGoals = completed.body.goals as { status: string }[];
    expect(demoGoals[0]!.status).toBe('completed');

    const today = await injectJson('GET', `/api/demo/today?now=${DEMO_ACHIEVED_DAY}`);
    expect((today.body.unlock as { status: string }).status).toBe('UNLOCKED');
    expect(today.body.dummyPassword).toBe('デモ用 123456'); // 本物ではなくダミー。

    // --- 操作後スナップショット: 本番は完全に不変 ---
    const revealAfter = await injectJson('POST', '/api/password/reveal', { date: REVEAL_DATE });
    expect(revealAfter.body).toEqual(revealBefore.body); // reveal 出力が一字一句同じ。

    const goalsAfter = await injectJson('GET', '/api/goals');
    expect(goalsAfter.body).toEqual(goalsBefore.body); // 本番の目標は無傷（ゼロのまま）。

    const cfgAfter = getConfig(db);
    expect(cfgAfter).toEqual(cfgBefore); // 本番設定も無傷。
  });

  it('本番 reveal は空 DB で本物のパスワード生成コマンドを走らせない（未達成は返さない）', async () => {
    const reveal = await injectJson('POST', '/api/password/reveal', { date: REVEAL_DATE });
    expect(reveal.body.unlocked).toBe(false);
    // 未達成では候補を一切生成しない（脱出弁なし）。
    expect(reveal.body.entries).toEqual([]);
  });
});
