import { defineConfig } from 'vitest/config';

// Single root config that collects unit tests from every workspace package.
// Most extension SW code is bundled/verified manually (needs the real chrome.tabGroups/
// idle/windows runtime), so it stays out of this glob. group-rule-snapshot-identity added
// extension/src/*.test.ts for the pure-logic pieces (rename-candidate detection/debounce
// merge) plus a minimal in-memory chrome.storage.local fake — no real browser runtime needed.
export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'server/src/**/*.test.ts', 'extension/src/**/*.test.ts'],
    environment: 'node',
    globals: false,
  },
});
