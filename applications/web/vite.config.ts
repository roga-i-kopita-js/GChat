import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const backend = process.env.GCHAT_BACKEND_URL ?? 'http://127.0.0.1:3000';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: backend, rewrite: (path: string): string => path.replace(/^\/api/, '') },
      '/ws': { target: backend, ws: true },
    },
  },
});
