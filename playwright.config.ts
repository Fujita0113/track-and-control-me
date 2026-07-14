import { defineConfig, devices } from '@playwright/test';

/**
 * E2E（ブラウザ駆動）設定。デモモード（本番 DB 非依存）で SPA を実ブラウザ検証する。
 * - サーバは webServer で自動起動（DB_PATH=:memory: なので本番データに触れない）。
 * - vitest（*.test.ts）とは分離: testDir=e2e / testMatch=*.spec.ts で衝突しない。
 */

const PORT = 8899;
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'line' : 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  // SPA を配信するローカルサーバを自動起動（インメモリ DB＝本番非干渉）。
  webServer: {
    command: 'npm run server',
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: {
      PORT: String(PORT),
      DB_PATH: ':memory:',
    },
  },
});
