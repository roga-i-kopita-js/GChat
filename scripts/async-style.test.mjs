import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cases = [
  { code: 'await task().then(done);', errors: 1 },
  { code: 'await task().catch(failed);', errors: 1 },
  { code: 'await task().finally(cleanup);', errors: 1 },
  { code: 'return task().then(done);', errors: 1 },
  { code: 'return task().catch(failed);', errors: 1 },
  { code: 'return task().finally(cleanup);', errors: 1 },
  { code: 'const then = task.then; then(done);', errors: 1 },
  { code: 'task[`then`](done);', errors: 1 },
  { code: 'const value = object.other;', errors: 0 },
  { code: 'void task().catch(failed);', errors: 1 },
  { code: 'task.then(done).catch(failed).finally(cleanup);', errors: 3 },
  { code: 'await task["then"](done);', errors: 1 },
  { code: 'task["catch"](failed);', errors: 1 },
  { code: 'task["finally"](cleanup);', errors: 1 },
  { code: 'await task?.then?.(done);', errors: 1 },
  { code: 'await task?.catch?.(failed);', errors: 1 },
  { code: 'await task?.finally?.(cleanup);', errors: 1 },
  { code: 'await task();', errors: 0 },
  {
    code: 'try { await task(); } catch (error) { handle(error); } finally { cleanup(); }',
    errors: 0,
  },
  { code: 'await Promise.all(tasks); await Promise.allSettled(tasks);', errors: 0 },
  { code: 'await Promise.race(tasks); await Promise.any(tasks);', errors: 0 },
  { code: 'await new Promise(resolve => resolve());', errors: 0 },
  { code: 'schema.catch("");', errors: 1 },
  {
    code: `/* oxlint-disable gchat/no-promise-chains -- Zod validation fallback. */
      const schema = z.string().catch('');
      /* oxlint-enable gchat/no-promise-chains */
      await task().catch(failed);`,
    errors: 1,
  },
];

test('strict async style rejects Promise chains including awaited handlers', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gchat-async-style-'));

  try {
    const config = join(directory, '.oxlintrc.json');
    const fixture = join(directory, 'fixture.ts');
    const applicationConfig = JSON.parse(readFileSync(join(root, '.oxlintrc.json'), 'utf8'));

    writeFileSync(
      config,
      JSON.stringify({
        categories: { correctness: 'off' },
        jsPlugins: [join(root, 'scripts/oxlint-plugin.mjs')],
        rules: {
          'gchat/no-promise-chains': applicationConfig.rules['gchat/no-promise-chains'],
        },
      }),
    );

    for (const { code, errors } of cases) {
      writeFileSync(fixture, `async function example() { ${code} }`);
      const result = spawnSync(
        join(root, 'node_modules/.bin/oxlint'),
        ['--config', config, '--format', 'json', fixture],
        { encoding: 'utf8' },
      );

      assert.ifError(result.error);
      assert.equal(result.status, errors ? 1 : 0, result.stderr || result.stdout);
      const report = JSON.parse(result.stdout);

      assert.equal(report.diagnostics.length, errors, code);

      for (const diagnostic of report.diagnostics) {
        assert.match(diagnostic.code, /gchat\(no-promise-chains\)/, code);
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
