// Runs only inside the disposable image smoke test; all credentials are ephemeral.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import pg from 'pg';
import WebSocket from 'ws';

import { hashPassword, parsePasswordPepper } from './dist/auth/auth.password.js';

const origin = 'https://smoke.invalid';
const base = 'https://127.0.0.1';
const password = randomBytes(32).toString('hex');
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const hash = await hashPassword(password, parsePasswordPepper(process.env.AUTH_PASSWORD_PEPPER));

try {
  await db.query(
    "INSERT INTO gchat_users (login, display_name, password_hash, role) VALUES ('release-smoke', 'Smoke', $1, 'admin')",
    [hash],
  );
} finally {
  await db.end();
}

async function get(path) {
  return fetch(base + path, { signal: AbortSignal.timeout(10000) });
}

assert.equal((await get('/api/ready')).status, 200);
const root = await fetch(base + '/?source=smoke', { redirect: 'manual' });

assert.equal(root.status, 302);
assert.equal(root.headers.get('location'), '/apps/client?source=smoke');
const html = await (await get('/apps/client')).text();

assert.match(html, /<html/);
assert.equal(await (await get('/apps/client/admin/users?offset=0')).text(), html);
const assets = [...html.matchAll(/(?:src|href)="(\/apps\/static\/[^"\s]+)"/g)];

assert.ok(assets.length > 0);

for (const [, asset] of assets) {
  const response = await get(asset);

  assert.equal(response.status, 200);
  assert.ok((await response.arrayBuffer()).byteLength > 0);
}

assert.equal((await get('/apps/static/missing.js')).status, 404);
assert.equal((await get('/unknown')).status, 404);
const login = await fetch(base + '/api/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ login: 'release-smoke', password }),
});

assert.equal(login.status, 200);
const tokens = await login.json();
const ticketResponse = await fetch(base + '/api/auth/ws-ticket', {
  method: 'POST',
  headers: {
    Authorization: 'Bearer ' + tokens.access_token,
    Origin: origin,
    'Content-Type': 'application/json',
  },
  body: '{}',
});

assert.equal(ticketResponse.status, 200);
const { ticket } = await ticketResponse.json();

await new Promise((resolve, reject) => {
  const socket = new WebSocket('wss://127.0.0.1/ws', ['gchat', 'ticket.' + ticket], {
    origin,
    rejectUnauthorized: false,
    handshakeTimeout: 10000,
  });
  const timer = setTimeout(() => {
    socket.terminate();
    reject(new Error('WSS timed out'));
  }, 12000);

  socket.on('error', reject);
  socket.on('open', () => {
    assert.equal(socket.protocol, 'gchat');
    socket.close();
  });
  socket.on('close', () => {
    clearTimeout(timer);
    resolve();
  });
});
