import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cases = [
  { code: 'const value = { user: await load() };', errors: 1 },
  { code: 'return { user: (await load()).user };', errors: 1 },
  { code: 'consume({ users: [await load()] });', errors: 1 },
  { code: 'value = { nested: { user: await load() } };', errors: 1 },
  { code: 'const value = { ...(await load()) };', errors: 1 },
  { code: 'const value = { [await key()]: true };', errors: 1 },
  { code: 'const value = { user: (await load()) as User };', errors: 1 },
  { code: 'const value = { first: await load(), second: await load() };', errors: 2 },
  { code: 'const user = await load(); const value = { user };', errors: 0 },
  { code: 'const value = await load();', errors: 0 },
  { code: 'const value = { async load() { return await load(); } };', errors: 0 },
  { code: 'const value = { load: async () => await load() };', errors: 0 },
  { code: 'const value = { load: async function () { return await load(); } };', errors: 0 },
  { code: 'const value = { nested: { load: async () => await load() } };', errors: 0 },
  { code: 'const value = { async load() { return { user: await load() }; } };', errors: 1 },
  { code: 'const value = { load: async () => ({ user: await load() }) };', errors: 1 },
];

test('object await rule reports construction and respects function boundaries', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gchat-object-await-'));

  try {
    const config = join(directory, '.oxlintrc.json');
    const fixture = join(directory, 'fixture.ts');

    writeFileSync(
      config,
      JSON.stringify({
        categories: { correctness: 'off' },
        jsPlugins: [join(root, 'scripts/oxlint-plugin.mjs')],
        rules: { 'gchat/no-await-in-object': 'error' },
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
        assert.match(diagnostic.code, /gchat\(no-await-in-object\)/, code);
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
