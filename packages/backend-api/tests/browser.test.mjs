import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

import { buildSync } from 'esbuild';

test('browser bundle loads with browser globals and performs a request', async () => {
  const result = buildSync({
    stdin: { contents: "export * from '@gchat/backend-api';", resolveDir: process.cwd() },
    bundle: true,
    platform: 'browser',
    format: 'iife',
    globalName: 'BrowserApi',
    target: ['chrome104', 'firefox102', 'safari16.4'],
    write: false,
  });
  const context = {
    Headers,
    Response,
    URLSearchParams,
    fetch: async () =>
      new Response('{"groups":[]}', { headers: { 'Content-Type': 'application/json' } }),
  };

  runInNewContext(result.outputFiles[0].text, context);
  const api = new context.BrowserApi.BackendApi({ baseUrl: '/api' });

  assert.equal(JSON.stringify((await api.groupsList()).data), '{"groups":[]}');
});
