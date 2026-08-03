import { defineConfig, devices } from '@playwright/test';

/**
 * E2E（ブラウザ駆動）設定。デモモード（本番 DB 非依存）で SPA を実ブラウザ検証する。
 * - サーバはワーカーごとに `e2e/fixtures.ts` が自動起動する（DB_PATH=:memory: なので本番データに触れない）。
 *   1プロセス共有だと fullyParallel 下で他 spec の書き込みがアサーションに混ざるため、
 *   ワーカーごとに専用サーバー＋専用DBを持たせて完全分離している。
 * - vitest（*.test.ts）とは分離: testDir=e2e / testMatch=*.spec.ts で衝突しない。
 */

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'line' : 'list',
  use: {
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
