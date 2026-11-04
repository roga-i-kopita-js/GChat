import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const repository = fileURLToPath(new URL('../../../', import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), 'gchat-backend-api-'));
const run = (args, cwd = repository) => execFileSync('pnpm', args, { cwd, stdio: 'inherit' });

async function compare(expected, actual) {
  const entries = await readdir(expected, { withFileTypes: true });
  const actualEntries = await readdir(actual, { withFileTypes: true });

  if (
    JSON.stringify(entries.map((e) => e.name).sort()) !==
    JSON.stringify(actualEntries.map((e) => e.name).sort())
  )
    throw new Error(`Generated file set differs: ${expected}`);

  for (const entry of entries) {
    const left = join(expected, entry.name);
    const right = join(actual, entry.name);

    if (entry.isDirectory()) await compare(left, right);
    else if (!(await readFile(left)).equals(await readFile(right)))
      throw new Error(`Stale API artifact: ${left}`);
  }
}

try {
  run(['--filter', '@gchat/backend', 'build']);
  run(['--filter', '@gchat/backend', 'openapi:export', join(temporary, 'openapi.json')]);
  const snapshot = await readFile(join(root, 'openapi.json'));

  if (!snapshot.equals(await readFile(join(temporary, 'openapi.json'))))
    throw new Error('Stale openapi.json; run pnpm api:generate');

  run(['generate', join(temporary, 'openapi.json'), join(temporary, 'generated')], root);
  await compare(join(root, 'src/generated'), join(temporary, 'generated'));
  console.log('OpenAPI and generated API sources are current.');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
