import { defineConfig } from 'vitest/config';

// Single root config that collects unit tests from every workspace package.
// Extension SW code is bundled/verified manually (needs the chrome.* runtime),
// so only pure-logic modules under packages/ and server/ are unit-tested here.
export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'server/src/**/*.test.ts'],
    environment: 'node',
    globals: false,
  },
});
