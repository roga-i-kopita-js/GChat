import { defineConfig } from '@playwright/test';

import base from './playwright.config';

const webPort = Number(process.env.GCHAT_ROUTER_WEB_PORT ?? '5173');

if (!Number.isInteger(webPort) || webPort < 1 || webPort > 65535) {
  throw new Error('Invalid router Web port');
}

const webOrigin = `http://127.0.0.1:${webPort}`;

// Reuse only the isolated GChat E2E stand; these scenarios never target working accounts.
export default defineConfig({
  ...base,
  projects: base.projects
    ?.filter((project): boolean => project.name === 'web')
    .map((project): typeof project => ({
      ...project,
      use: { ...project.use, baseURL: webOrigin },
      testMatch: ['**/web/dialogs.e2e.ts', '**/web/direct-calls.e2e.ts'],
    })),
  webServer: [
    {
      command: 'pnpm backend',
      url: 'http://127.0.0.1:3300/ready',
      reuseExistingServer: true,
      timeout: 30000,
    },
    {
      command: `pnpm --filter @gchat/web exec vite --host 127.0.0.1 --port ${webPort}`,
      url: webOrigin,
      reuseExistingServer: true,
      timeout: 30000,
      env: { GCHAT_BACKEND_URL: 'http://127.0.0.1:3300' },
    },
  ],
});
