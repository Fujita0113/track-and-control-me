import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { DEFAULTS } from '@track/contract';

/**
 * ランタイム設定（DB パス・待受ホスト/ポート・静的配信ディレクトリ）。
 * 秘密のうち共有トークンは DB(app_config.shared_token) が権威。ここでは
 * ブートストラップの port/db パスのみ扱う。env > config.local.json > 既定。
 *
 * ポートフォールバック（spec: server-port-fallback / design.md D1・D2）のため、
 * 「ポート確定前に必要な値」と「ポート確定後に dbPath を解決する」処理を分離する:
 *   1. `loadPreBindConfig()` — 候補ポート・env/file の dbPath・serverRoot を返す。
 *   2. `findAvailablePort()` — 候補ポートから実際にバインドできるポートを探す。
 *   3. `resolveDbPath()` — 確定ポートを使って dbPath を解決する。
 */

const here = dirname(fileURLToPath(import.meta.url)); // .../server/src
const serverRoot = resolve(here, '..'); // .../server

interface FileConfig {
  port?: number;
  dbPath?: string;
}

function readFileConfig(): FileConfig {
  const p = join(serverRoot, 'config.local.json');
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as FileConfig;
  } catch {
    return {};
  }
}

export interface PreBindConfig {
  host: string;
  /** 設定ポート（環境変数 `PORT` > `config.local.json` の `port` > 既定値）。実バインド前の候補。 */
  basePort: number;
  explicitDbPath: string | undefined;
  fileDbPath: string | undefined;
  serverRoot: string;
  staticDir: string;
}

/** ポート確定前に必要な値を返す（design.md D1）。 */
export function loadPreBindConfig(): PreBindConfig {
  const file = readFileConfig();
  const basePort = Number(process.env.PORT ?? file.port ?? DEFAULTS.WS_PORT);
  return {
    host: '127.0.0.1', // 常に localhost バインド（design.md D2）
    basePort,
    explicitDbPath: process.env.DB_PATH,
    fileDbPath: file.dbPath,
    serverRoot,
    staticDir: join(serverRoot, 'static'),
  };
}

/**
 * `basePort` から `host` へ試験リッスン→即クローズし、空きポートを探す（design.md D1）。
 * 使用中(`EADDRINUSE`)なら次のポートを試す。`maxAttempts` 個すべて使用中なら reject する。
 */
export function findAvailablePort(basePort: number, host: string, maxAttempts = 20): Promise<number> {
  function tryPort(port: number, attemptsLeft: number): Promise<number> {
    return new Promise((resolvePort, reject) => {
      const server = createServer();
      server.once('error', (err: NodeJS.ErrnoException) => {
        server.close();
        if (err.code === 'EADDRINUSE' && attemptsLeft > 1) {
          resolvePort(tryPort(port + 1, attemptsLeft - 1));
        } else if (err.code === 'EADDRINUSE') {
          reject(
            new Error(
              `空きポートが見つかりません（${basePort}〜${basePort + maxAttempts - 1} は全て使用中です）`,
            ),
          );
        } else {
          reject(err);
        }
      });
      server.listen(port, host, () => {
        server.close(() => resolvePort(port));
      });
    });
  }
  return tryPort(basePort, maxAttempts);
}

export interface ResolveDbPathInput {
  /** `DB_PATH` 環境変数（明示指定、最優先）。 */
  explicitDbPath: string | undefined;
  /** `config.local.json` の `dbPath`。 */
  fileDbPath: string | undefined;
  serverRoot: string;
  basePort: number;
  /** `findAvailablePort` で実際にバインドできたポート。 */
  actualPort: number;
}

/**
 * DB 接続先を解決する（design.md D2）。優先順位: 明示指定 > file 指定 >
 * (実際にバインドできたポートが設定ポートと一致すれば実DB／フォールバックなら開発用DB)。
 */
export function resolveDbPath(input: ResolveDbPathInput): string {
  if (input.explicitDbPath) return input.explicitDbPath;
  if (input.fileDbPath) return input.fileDbPath;
  return input.actualPort === input.basePort
    ? join(input.serverRoot, 'data', 'track.sqlite')
    : join(input.serverRoot, 'data', 'track.dev.sqlite');
}

/** DB ディレクトリを用意する（`:memory:` 以外）。dbPath 確定後に呼ぶ。 */
export function ensureDbDir(dbPath: string): void {
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
}
