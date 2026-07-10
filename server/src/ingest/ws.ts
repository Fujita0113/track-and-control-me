import type { FastifyInstance } from 'fastify';
import { ClientMessageSchema, WS_PATH, type ServerMessage } from '@track/contract';
import type { DB } from '../db/index.js';
import { getConfig } from '../db/index.js';
import { storeSample } from '../services/ingest.js';

/**
 * `/ingest` WebSocket ルート（design.md D2）。
 * 初回に `hello` でトークン照合 → welcome。以後 `sample`/`ping` を処理。
 * サンプルは冪等保存し、保存できたら onSampleStored でダウンストリーム再計算を促す。
 */

export interface IngestDeps {
  db: DB;
  /** 現在有効な共有トークン（空文字なら dev モードで無認証許可）。 */
  getToken: () => string;
  /** 新規サンプルが保存されたときに呼ばれる（再計算のトリガ）。 */
  onSampleStored: () => void;
  log?: (msg: string) => void;
}

function send(socket: { send: (data: string) => void }, msg: ServerMessage): void {
  socket.send(JSON.stringify(msg));
}

export function registerIngestRoute(app: FastifyInstance, deps: IngestDeps): void {
  app.get(WS_PATH, { websocket: true }, (socket, req) => {
    let authed = false;
    const peer = req.ip ?? 'local';

    socket.on('message', (raw: unknown) => {
      let parsed;
      try {
        const text = typeof raw === 'string' ? raw : String(raw);
        parsed = ClientMessageSchema.parse(JSON.parse(text));
      } catch {
        send(socket, { type: 'error', reason: 'invalid message' });
        return;
      }

      if (parsed.type === 'hello') {
        const token = deps.getToken();
        if (token !== '' && parsed.token !== token) {
          send(socket, { type: 'error', reason: 'bad token' });
          socket.close();
          deps.log?.(`ingest: 認証失敗 (${peer})`);
          return;
        }
        authed = true;
        // 復帰通知の閾値を配布（timeline-revamp D7）。拡張は未受領時 DEFAULTS.AWAY_MIN_SECONDS へフォールバック。
        const awayMinSeconds = getConfig(deps.db).away_min_seconds;
        send(socket, { type: 'welcome', serverTime: Date.now(), awayMinSeconds });
        deps.log?.(
          `ingest: 接続確立 (${peer}) ext=${parsed.extVersion} boot=${parsed.bootId}` +
            (token === '' ? ' [警告: トークン未設定=dev モード]' : ''),
        );
        return;
      }

      if (!authed) {
        send(socket, { type: 'error', reason: 'not authenticated' });
        socket.close();
        return;
      }

      if (parsed.type === 'ping') {
        send(socket, { type: 'pong', serverTime: Date.now() });
        return;
      }

      // parsed.type === 'sample'
      try {
        const { inserted } = storeSample(deps.db, parsed.sample, Date.now());
        send(socket, { type: 'ack', bootId: parsed.sample.bootId, seq: parsed.sample.seq });
        if (inserted) deps.onSampleStored();
      } catch (err) {
        deps.log?.(`ingest: 保存失敗 ${(err as Error).message}`);
        send(socket, { type: 'error', reason: 'store failed' });
      }
    });

    socket.on('error', () => {
      /* 切断は拡張側が指数バックオフで再接続する */
    });
  });
}
