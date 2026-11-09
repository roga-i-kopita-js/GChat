import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cases = [
  { code: 'await asyncFn().property;', errors: 1 },
  { code: 'await asyncFn()[key];', errors: 1 },
  { code: 'await asyncFn().method();', errors: 0 },
  { code: 'await asyncFn().property.nested;', errors: 1 },
  { code: 'await asyncFn().property.nested();', errors: 0 },
  { code: 'await asyncFn()?.property;', errors: 1 },
  { code: 'await asyncFn?.().property;', errors: 1 },
  { code: 'await asyncFn()?.method?.();', errors: 0 },
  { code: 'await (asyncFn() as Result).property;', errors: 1 },
  { code: 'await asyncFn()!.property;', errors: 1 },
  { code: 'await (asyncFn() satisfies Result).property;', errors: 1 },
  { code: 'await (new Promise(resolve => resolve())).property;', errors: 1 },
  { code: 'await factory().ready;', errors: 1 },
  { code: 'const result = await asyncFn(); result.property;', errors: 1 },
  { code: '(await asyncFn()).property;', errors: 1 },
  { code: '(await asyncFn())[key];', errors: 1 },
  { code: 'await (await asyncFn()).method();', errors: 1 },
  { code: 'await service.load();', errors: 0 },
  { code: 'await page.getByRole("button").click();', errors: 0 },
  { code: 'await service?.load?.();', errors: 0 },
  { code: 'await asyncFn();', errors: 0 },
  { code: 'const object = factory(); await object.ready;', errors: 0 },
  { code: 'await Promise.all(tasks);', errors: 0 },
  { code: 'await consume(factory().property);', errors: 0 },
  { code: 'const { property } = await asyncFn(); consume(property);', errors: 0 },
  { code: 'const { property: renamed = 0 } = await asyncFn(); consume(renamed);', errors: 0 },
  { code: 'const { user } = await asyncFn(); user.name;', errors: 0 },
  { code: 'const { user: { name } } = await asyncFn(); consume(name);', errors: 0 },
  { code: 'const result = await asyncFn(); result?.property;', errors: 1 },
  { code: 'const result = await asyncFn(); result[key];', errors: 1 },
  { code: 'const result = await asyncFn(); const alias = result; alias.property;', errors: 1 },
  { code: 'const result = (await asyncFn()) as Result; result.property;', errors: 1 },
  { code: '((await asyncFn()) as Result)?.property;', errors: 1 },
  { code: 'const result = await asyncFn(); (() => result.property)();', errors: 1 },
  {
    code: 'const result = await asyncFn(); function inner(result) { return result.property; }',
    errors: 0,
  },
  { code: 'const result = await asyncFn(); { const result = {}; result.property; }', errors: 0 },
  { code: 'const alias = result; const result = await asyncFn(); alias.property;', errors: 1 },
  { code: 'const first = second; const second = first; first.property;', errors: 0 },
  { code: 'const result = await asyncFn(); return result;', errors: 0 },
  { code: 'const value = await loadCount(); consume(value);', errors: 0 },
];

test('await result properties require destructuring', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gchat-await-call-member-'));

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
          'gchat/no-await-call-member': applicationConfig.rules['gchat/no-await-call-member'],
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
        assert.match(diagnostic.code, /gchat\(no-await-call-member\)/, code);
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
