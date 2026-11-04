import { execFileSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';

await rm('dist', { recursive: true, force: true });
execFileSync('pnpm', ['exec', 'tsc'], { stdio: 'inherit' });
execFileSync(
  'pnpm',
  ['exec', 'tsc', '--module', 'CommonJS', '--moduleResolution', 'Node', '--outDir', 'dist/cjs'],
  { stdio: 'inherit' },
);
await mkdir('dist/cjs', { recursive: true });
await writeFile('dist/cjs/package.json', '{"type":"commonjs"}\n');
