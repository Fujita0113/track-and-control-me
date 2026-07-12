import { openDb, type DB } from '../db/index.js';
import { seedDemo } from './demo-seed.js';

/**
 * デモ（お試し）モードの分離データセット（spec: demo-mode / design.md D1）。
 * 本番と同じマイグレーション＋既定 seed を流したインメモリ SQLite（`:memory:`）を
 * 遅延構築してキャッシュする。本番 DB のコネクションには一切触れない。
 * 単一ユーザのローカルアプリなのでセッション多重化はせず、1つの常駐デモ DB を持つ。
 */

let cached: DB | null = null;

function build(): DB {
  // openDb は本番と同一のマイグレーション＋既定 config を適用する（スキーマ整合を保証）。
  const db = openDb(':memory:');
  seedDemo(db);
  return db;
}

/** キャッシュ済みのデモ DB を返す（無ければ構築）。 */
export function getDemoDb(): DB {
  if (!cached) cached = build();
  return cached;
}

/** デモ DB を破棄して再 seed する（`デモ開始` / `サンプルをリセット`）。 */
export function resetDemoDb(): DB {
  if (cached) {
    try {
      cached.close();
    } catch {
      /* noop */
    }
  }
  cached = build();
  return cached;
}
