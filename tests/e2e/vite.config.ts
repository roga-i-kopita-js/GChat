import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 5174,
    strictPort: true,
    hmr: false,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3300',
        rewrite: (path: string): string => path.replace(/^\/api/, ''),
      },
      '/ws': { target: 'http://127.0.0.1:3300', ws: true },
    },
  },
});
