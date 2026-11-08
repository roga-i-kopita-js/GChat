import { readFileSync } from 'node:fs';

import react from '@vitejs/plugin-react';
import { defineConfig, type UserConfig } from 'vite';

import { pwaPlugin } from './pwa/plugin.js';

const backend = process.env.GCHAT_BACKEND_URL ?? 'http://127.0.0.1:3000';
const certFile = process.env.GCHAT_HTTPS_CERT_FILE;
const keyFile = process.env.GCHAT_HTTPS_KEY_FILE;

if (!!certFile !== !!keyFile) {
  throw new Error('Provide both HTTPS certificate and key files');
}

export default defineConfig(({ mode }): UserConfig => ({
  plugins: [react(), pwaPlugin(mode === 'server')],
  base: mode === 'server' ? '/apps/' : '/',
  build: { assetsDir: mode === 'server' ? 'static' : 'assets' },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    https:
      certFile && keyFile
        ? { cert: readFileSync(certFile), key: readFileSync(keyFile) }
        : undefined,
    proxy: {
      '/api': { target: backend, rewrite: (path: string): string => path.replace(/^\/api/, '') },
      '/ws': { target: backend, ws: true },
    },
  },
}));
