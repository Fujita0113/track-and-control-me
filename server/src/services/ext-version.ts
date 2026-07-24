import type { DB } from '../db/index.js';

/**
 * 拡張機能ビルドの検出（design.md D7-4・spec: extension-stable-group-id）。
 * 「修正済みコードがブラウザへ反映されていない」を無警告で見逃さないための可視化。
 */

/** 拡張機能の最小要求バージョン（`extension/manifest.json` の `version` と同期させる）。 */
export const MIN_EXTENSION_VERSION = '0.2.0';

/** セマンティックバージョン比較（x.y.z の数値比較。pre-release 識別子等は考慮しない最小実装）。 */
export function isVersionBelow(version: string, minVersion: string): boolean {
  const a = version.split('.').map((n) => Number(n) || 0);
  const b = minVersion.split('.').map((n) => Number(n) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}

/** 直近に受信したサンプルの拡張バージョン（未受信なら null）。 */
export function latestExtVersion(db: DB): string | null {
  const row = db.prepare('SELECT ext_version FROM raw_sample ORDER BY id DESC LIMIT 1').get() as
    | { ext_version: string }
    | undefined;
  return row?.ext_version ?? null;
}

/** 直近の拡張ビルドが最小要求版未満か（未受信＝判定不能のときは false）。 */
export function isExtensionOutdated(db: DB): boolean {
  const v = latestExtVersion(db);
  return v != null && isVersionBelow(v, MIN_EXTENSION_VERSION);
}
