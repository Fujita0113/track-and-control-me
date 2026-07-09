import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { loadRuntimeConfig } from './config.js';
import { openDb, getConfig } from './db/index.js';
import { registerIngestRoute } from './ingest/ws.js';
import { runPipeline } from './services/pipeline.js';
import { registerApiRoutes } from './api/index.js';
import { startRollover } from './services/rollover.js';

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'";

async function main(): Promise<void> {
  const rc = loadRuntimeConfig();
  const db = openDb(rc.dbPath);

  // 静的配信ディレクトリを保証（F5 の実体が無くても起動できるように）。
  if (!existsSync(rc.staticDir)) {
    mkdirSync(rc.staticDir, { recursive: true });
    writeFileSync(
      join(rc.staticDir, 'index.html'),
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
  await app.register(fastifyStatic, { root: rc.staticDir, prefix: '/' });

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

  await app.listen({ host: rc.host, port: rc.port });
  app.log.info(`backend 起動: http://${rc.host}:${rc.port}  db=${rc.dbPath}`);

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
