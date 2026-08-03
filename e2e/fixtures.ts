import { test as base, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

/**
 * ワーカーごとに専用サーバー（DB_PATH=:memory:）を立てて完全分離する（並列実行のデータ競合対策）。
 * 単一 webServer 共有だと、fullyParallel 下で他 spec の書き込みが自分のアサーションに混ざる
 * （strict mode 違反・要素の取りこぼし・グローバル状態＝ゲートの誤判定）ため、
 * config.ts の findAvailablePort と同じ「ポートがずれても実害はない」設計に寄せ、
 * ワーカー数ぶんだけ独立した :memory: サーバーを起動する。
 *
 * `tsx` の .cmd（Windows）を shell 経由で起動すると kill() がラッパーにしか届かず
 * 実体の node プロセスが残る（このリポジトリで実際に孤児プロセスとして観測済み）ため、
 * `node --require tsx/preflight --import tsx <entry>` の形で node を直接起動する
 * （`node_modules/.bin/tsx` が内部で行っているのと同じ起動方法）。
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const serverRoot = path.resolve(repoRoot, 'server');
const tsxPreflight = path.resolve(repoRoot, 'node_modules', 'tsx', 'dist', 'preflight.cjs');
const tsxLoaderUrl = pathToFileURL(path.resolve(repoRoot, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
const BASE_PORT = 8899;

async function waitForServer(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch {
      // まだ起動していない。次のポーリングへ。
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`e2e worker server did not start in time: ${url}`);
}

async function stopServer(proc: ChildProcess): Promise<void> {
  await new Promise<void>((resolve) => {
    proc.once('exit', () => resolve());
    proc.kill();
    // Windows は SIGTERM を無視することがあるため、少し待って生きていたら強制終了する。
    setTimeout(() => {
      if (!proc.killed) proc.kill('SIGKILL');
    }, 3000);
  });
}

export const test = base.extend<Record<string, never>, { workerServerURL: string }>({
  workerServerURL: [
    async ({}, use, workerInfo) => {
      const port = BASE_PORT + workerInfo.workerIndex;
      const url = `http://127.0.0.1:${port}`;
      const proc = spawn(
        process.execPath,
        ['--require', tsxPreflight, '--import', tsxLoaderUrl, '--env-file-if-exists=.env', 'src/main.ts'],
        {
          cwd: serverRoot,
          env: { ...process.env, PORT: String(port), DB_PATH: ':memory:' },
          stdio: 'pipe',
          windowsHide: true,
        },
      );
      await waitForServer(url);
      await use(url);
      await stopServer(proc);
    },
    { scope: 'worker', auto: true },
  ],

  baseURL: async ({ workerServerURL }, use) => {
    await use(workerServerURL);
  },
});

export { expect };
