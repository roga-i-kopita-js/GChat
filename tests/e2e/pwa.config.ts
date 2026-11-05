import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/pwa',
  testMatch: '**/*.e2e.ts',
  workers: 1,
  timeout: 30000,
  use: { baseURL: 'http://127.0.0.1:5186', trace: 'off' },
  webServer: {
    command: 'node scripts/pwa-server.mjs',
    url: 'http://127.0.0.1:5186/__ready',
    reuseExistingServer: false,
  },
});
