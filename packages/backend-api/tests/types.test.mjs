import { execFileSync } from 'node:child_process';
import test from 'node:test';

test('ESM and CommonJS consumers resolve declarations through package exports', () => {
  execFileSync(
    'pnpm',
    [
      'exec',
      'tsc',
      '--strict',
      '--noEmit',
      '--target',
      'ES2022',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      'tests/consumer.mts',
      'tests/consumer.cts',
    ],
    { stdio: 'pipe' },
  );
});
