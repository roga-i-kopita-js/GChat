import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const settings = JSON.parse(
  await readFile(new URL('../../web/.local/backend.json', import.meta.url), 'utf8'),
);
const server = spawn(process.execPath, ['dist/main.js'], {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  env: { ...process.env, ...settings },
  stdio: 'inherit',
});

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.kill(signal));

server.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
