import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { loadPreBindConfig, findAvailablePort, resolveDbPath, ensureDbDir } from './config.js';
import { openDb, getConfig } from './db/index.js';
import { registerIngestRoute } from './ingest/ws.js';
import { runPipeline } from './services/pipeline.js';
import { registerApiRoutes } from './api/index.js';
import { startRollover } from './services/rollover.js';
import { seedDevSample } from './services/dev-seed.js';

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'";

async function main(): Promise<void> {
  // 起動順（design.md D1・D2・D4）: (1) 候補ポート確定 → (2) 実ポート確定 →
  // (3) dbPath 確定 → (4) 開発用DBを新規作成する場合はサンプル投入対象としてフラグを立てる →
  // (5) openDb（新規なら直後に seedDevSample）。
  const pre = loadPreBindConfig();
  let port: number;
  try {
    port = await findAvailablePort(pre.basePort, pre.host);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
  const fellBack = port !== pre.basePort;
  const dbPath = resolveDbPath({
    explicitDbPath: pre.explicitDbPath,
    fileDbPath: pre.fileDbPath,
    serverRoot: pre.serverRoot,
    basePort: pre.basePort,
    actualPort: port,
  });
  ensureDbDir(dbPath);
  const isDevDb = dbPath === ':memory:' || dbPath === join(pre.serverRoot, 'data', 'track.dev.sqlite');
  const needsDevSeed = isDevDb && !existsSync(dbPath);

  const db = openDb(dbPath);
  if (needsDevSeed) seedDevSample(db);

  // 静的配信ディレクトリを保証（F5 の実体が無くても起動できるように）。
  if (!existsSync(pre.staticDir)) {
    mkdirSync(pre.staticDir, { recursive: true });
    writeFileSync(
      join(pre.staticDir, 'index.html'),
      '<!doctype html><meta charset="utf-8"><title>Track & Control Me</title><p>dashboard は F5 で実装されます。</p>',
    );
  }

  const app = Fastify({ logger: { level: 'info' } });

  // 厳格 CSP（design.md D10）。localhost 完結。
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('Content-Security-Policy', CSP);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    return payload;
  });

  // WebSocket は全ルート登録より前に。
  await app.register(fastifyWebsocket);

  // --- debounced pipeline（ingest 後の再計算/評価/reveal）---
  let timer: NodeJS.Timeout | null = null;
  const schedulePipeline = (): void => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      try {
        runPipeline(db);
      } catch (err) {
        app.log.error({ err }, 'pipeline 失敗');
      }
    }, 3000);
  };

  registerIngestRoute(app, {
    db,
    getToken: () => getConfig(db).shared_token,
    onSampleStored: schedulePipeline,
    log: (m) => app.log.info(m),
  });

  // REST API（設定・集計・ルール・パスワード・タイムライン・カンバン）。
  await registerApiRoutes(app, { db, runPipeline: () => runPipeline(db) });

  // ダッシュボード静的配信。
  await app.register(fastifyStatic, { root: pre.staticDir, prefix: '/' });

  // 日次ロールオーバー（croner, 04:00）。
  const stopRollover = startRollover(db, (m) => app.log.info(m));

  const shutdown = async (): Promise<void> => {
    stopRollover();
    await app.close();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await app.listen({ host: pre.host, port });
  app.log.info(`backend 起動: http://${pre.host}:${port}  db=${dbPath}`);

  // pino の JSON 1行ログは目視しづらいため、平文バナーも出す（design.md D5）。
  const dbFileName = dbPath === ':memory:' ? ':memory:' : basename(dbPath);
  const fallbackLabel = fellBack ? 'fallback port; ' : '';
  console.log(`▶ track-and-control-me backend: http://${pre.host}:${port}  [${fallbackLabel}db: ${dbFileName}]`);

  // 起動直後に一度パイプラインを回して当日状態を最新化。
  try {
    runPipeline(db);
  } catch (err) {
    app.log.error({ err }, '初回 pipeline 失敗');
  }
}

main().catch((err) => {
  console.error('起動に失敗しました:', err);
  process.exit(1);
});
