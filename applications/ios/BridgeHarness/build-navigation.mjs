// Reuse the Web workspace toolchain; this diagnostic bundle adds no dependency copies.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const requireWeb = createRequire(new URL('../../web/package.json', import.meta.url));
const { build } = await import(requireWeb.resolve('vite'));

await build({
  configFile: false,
  root: fileURLToPath(new URL('../../web/', import.meta.url)),
  logLevel: 'warn',
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    outDir: fileURLToPath(new URL('dist/', import.meta.url)),
    emptyOutDir: true,
    lib: {
      entry: fileURLToPath(
        new URL('../../web/tests/native-navigation-harness.ts', import.meta.url),
      ),
      formats: ['es'],
      fileName: () => 'navigation.js',
    },
  },
});
console.log('Navigation harness bundle ready');
