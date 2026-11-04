import { fileURLToPath } from 'node:url';

import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  workers: 1,
  fullyParallel: false,
  timeout: 120000,
  use: {
    // Real protocol payloads contain credentials and SDP; no wire traces.
    trace: 'off',
    launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] },
  },
  projects: [
    {
      name: 'protocol',
      testMatch: '**/protocol/*.e2e.ts',
      use: { baseURL: 'http://127.0.0.1:5174' },
    },
    {
      name: 'web',
      testMatch: '**/web/*.e2e.ts',
      use: {
        baseURL: 'http://127.0.0.1:5173',
        permissions: ['microphone'],
        launchOptions: {
          args: [
            '--use-fake-device-for-media-stream',
            '--use-fake-ui-for-media-stream',
            '--use-file-for-fake-audio-capture=' +
              fileURLToPath(new URL('./.local/microphone.wav', import.meta.url)),
            '--autoplay-policy=no-user-gesture-required',
          ],
        },
      },
    },
  ],
  webServer: [
    {
      command: 'pnpm backend',
      url: 'http://127.0.0.1:3300/ready',
      env: {
        AUTH_ACCESS_TOKEN_TTL_SECONDS: process.env.AUTH_ACCESS_TOKEN_TTL_SECONDS ?? '15',
        DIRECT_CALLS_RINGING_TIMEOUT_SECONDS:
          process.env.DIRECT_CALLS_RINGING_TIMEOUT_SECONDS ?? '7',
        DIRECT_CALLS_CONNECTING_TIMEOUT_SECONDS:
          process.env.DIRECT_CALLS_CONNECTING_TIMEOUT_SECONDS ?? '18',
        DIRECT_CALLS_RECONNECT_TIMEOUT_SECONDS:
          process.env.DIRECT_CALLS_RECONNECT_TIMEOUT_SECONDS ?? '15',
      },
      reuseExistingServer: false,
      timeout: 30000,
    },
    {
      command: 'pnpm dev',
      url: 'http://127.0.0.1:5174/fixtures/protocol/participant.html',
      reuseExistingServer: false,
      timeout: 15000,
    },
    {
      command: 'pnpm --filter @gchat/web dev',
      url: 'http://127.0.0.1:5173',
      env: { GCHAT_BACKEND_URL: 'http://127.0.0.1:3300' },
      reuseExistingServer: false,
      timeout: 30000,
    },
  ],
  reporter: 'list',
});
