// SQLite オンラインバックアップ（WAL 対応）。使用中の DB でも安全にコピーする。
// 使い方: node scripts/backup-db.mjs [srcDbPath] [backupDir]
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';

const src = resolve(process.argv[2] ?? 'server/data/track.sqlite');
const backupDir = resolve(process.argv[3] ?? 'backups');
mkdirSync(backupDir, { recursive: true });

// タイムスタンプ（ローカル）。ファイル名衝突回避。
const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(
  now.getHours(),
)}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
const dest = join(backupDir, `track-${stamp}.sqlite`);

const db = new Database(src, { readonly: true });
try {
  await db.backup(dest);
  console.log(`backup 完了: ${dest}`);
} finally {
  db.close();
}
