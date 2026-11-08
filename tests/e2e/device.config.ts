import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: ['**/device/*.e2e.ts', '**/web/backoffice.e2e.ts'],
  workers: 1,
  timeout: 30000,
  use: { baseURL: 'http://127.0.0.1:5175', trace: 'off' },
  webServer: {
    command: 'pnpm --filter @gchat/web exec vite --host 127.0.0.1 --port 5175',
    url: 'http://127.0.0.1:5175',
    reuseExistingServer: false,
    timeout: 30000,
  },
  reporter: 'list',
});
