import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: '*.e2e.ts',
  workers: 1,
  timeout: 60000,
  use: {
    baseURL: process.env.WEB_TEST_URL ?? 'http://127.0.0.1:5173',
    permissions: ['microphone'],
    trace: 'retain-on-failure',
    launchOptions: {
      args: [
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
      ],
    },
  },
  reporter: 'list',
});
