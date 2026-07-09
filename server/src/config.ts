import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { DEFAULTS } from '@track/contract';

/**
 * ランタイム設定（DB パス・待受ホスト/ポート・静的配信ディレクトリ）。
 * 秘密のうち共有トークンは DB(app_config.shared_token) が権威。ここでは
 * ブートストラップの port/db パスのみ扱う。env > config.local.json > 既定。
 */

export interface RuntimeConfig {
  host: string;
  port: number;
  dbPath: string;
  staticDir: string;
}

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

export function loadRuntimeConfig(): RuntimeConfig {
  const file = readFileConfig();
  const port = Number(process.env.PORT ?? file.port ?? DEFAULTS.WS_PORT);
  const dbPath = process.env.DB_PATH ?? file.dbPath ?? join(serverRoot, 'data', 'track.sqlite');

  // DB ディレクトリを用意（:memory: 以外）。
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true });
  }

  return {
    host: '127.0.0.1', // 常に localhost バインド（design.md D2）
    port,
    dbPath,
    staticDir: join(serverRoot, 'static'),
  };
}
