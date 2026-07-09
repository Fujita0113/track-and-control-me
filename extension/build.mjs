// esbuild ビルド：Service Worker と popup を extension/dist へバンドルし、
// manifest.json / popup.html を dist にコピーする。dist が「未パッケージ拡張」として
// そのまま読み込めるフォルダになる。
//
// 出力形式は IIFE（クラシック worker）。manifest の background.service_worker も
// type:module を付けない classic worker とし、MV3 のモジュール worker 固有の
// エッジケースを避ける（sw.js / popup.js は単一ファイル・外部依存なし）。
//
// 接続先 ws://127.0.0.1 は host_permissions 不要（host_permissions/CORS は fetch/XHR
// にのみ適用。詳細は src/ws-client.ts のコメント参照）。CDN/リモート参照は一切無し。

import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const srcDir = resolve(root, 'src');
const distDir = resolve(root, 'dist');

rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome116'],
  legalComments: 'none',
  // 契約モジュール経由で zod が取り込まれるため minify でバンドルを小さく保つ。
  minify: true,
  logLevel: 'info',
};

await build({
  ...common,
  entryPoints: [resolve(srcDir, 'sw.ts')],
  outfile: resolve(distDir, 'sw.js'),
});

await build({
  ...common,
  entryPoints: [resolve(srcDir, 'popup.ts')],
  outfile: resolve(distDir, 'popup.js'),
});

cpSync(resolve(root, 'manifest.json'), resolve(distDir, 'manifest.json'));
cpSync(resolve(srcDir, 'popup.html'), resolve(distDir, 'popup.html'));

console.log('extension build complete -> extension/dist/');
