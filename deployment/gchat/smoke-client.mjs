// Runs only inside the disposable image smoke test; all credentials are ephemeral.
import assert from 'node:assert/strict';
import { createECDH, randomBytes, randomUUID } from 'node:crypto';

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
const htmlResponse = await get('/apps/client');

assert.equal(htmlResponse.headers.get('cache-control'), 'no-store');
const html = await htmlResponse.text();

assert.match(html, /<html/);
assert.equal(await (await get('/apps/client/admin/users?offset=0')).text(), html);
const assets = [...html.matchAll(/(?:src|href)="(\/apps\/static\/[^"\s]+)"/g)];

assert.ok(assets.length > 0);

for (const [, asset] of assets) {
  const response = await get(asset);

  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control') ?? '', /immutable/);
  assert.doesNotMatch(response.headers.get('content-type') ?? '', /text\/html/);
  assert.ok((await response.arrayBuffer()).byteLength > 0);
}

const worker = await get('/apps/sw.js');

assert.equal(worker.status, 200);
assert.equal(worker.headers.get('cache-control'), 'no-cache');
assert.match(worker.headers.get('content-type') ?? '', /(?:text|application)\/javascript/);
assert.match(await worker.text(), /gchat-shell-server-/);
const manifestResponse = await get('/apps/site.webmanifest');

assert.equal(manifestResponse.status, 200);
assert.equal(manifestResponse.headers.get('cache-control'), 'no-cache');
assert.match(
  manifestResponse.headers.get('content-type') ?? '',
  /application\/(?:manifest\+json|json)/,
);
const manifest = await manifestResponse.json();

assert.equal(manifest.id, '/apps/client');
assert.equal(manifest.scope, '/apps/client');
assert.equal(manifest.start_url, '/apps/client/calls');
assert.equal(manifest.display, 'standalone');
assert.ok(manifest.icons.length > 0);

for (const icon of manifest.icons) {
  assert.match(icon.src, /^\/apps\/icons\/[a-zA-Z0-9_.-]+\.png$/);
  const response = await get(icon.src);

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /image\/png/);
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

const socket = new WebSocket('wss://127.0.0.1/ws', ['gchat', 'ticket.' + ticket], {
  origin,
  rejectUnauthorized: false,
  handshakeTimeout: 10000,
});
const pending = new Map();
let registered = false;
const timer = setTimeout(() => socket.terminate(), 12000);

function command(type, payload) {
  const request_id = randomUUID();

  return new Promise((resolve, reject) => {
    pending.set(request_id, { resolve, reject });
    socket.send(JSON.stringify({ request_id, type, payload }));
  });
}

socket.on('message', (data) => {
  const message = JSON.parse(data.toString());
  const operation = pending.get(message.request_id);

  if (!operation) return;

  pending.delete(message.request_id);

  if (message.error)
    operation.reject(new Error('Smoke WSS command rejected: ' + message.error.code));
  else operation.resolve(message.payload);
});
socket.on('close', () => {
  for (const operation of pending.values()) operation.reject(new Error('Smoke WSS closed'));

  pending.clear();
});

try {
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  assert.equal(socket.protocol, 'gchat');
  const device = await command('device.register', { device_id: null });

  assert.equal(typeof device.device_id, 'string');
  const config = await command('device.web_push_config', {});

  assert.deepEqual(config, { public_key: process.env.WEB_PUSH_PUBLIC_KEY });
  const browserKey = createECDH('prime256v1');

  browserKey.generateKeys();
  const subscription = {
    endpoint: 'https://fcm.googleapis.com/gchat-release-smoke-' + randomUUID(),
    p256dh: browserKey.getPublicKey().toString('base64url'),
    auth: randomBytes(16).toString('base64url'),
  };

  assert.deepEqual(await command('device.web_push', { subscription }), {});
  registered = true;
  assert.deepEqual(await command('device.web_push', { subscription: null }), {});
  registered = false;
} finally {
  // No call is created, and this disposable subscription never receives a real push.
  if (registered && socket.readyState === WebSocket.OPEN)
    await command('device.web_push', { subscription: null }).catch(() => {});

  clearTimeout(timer);
  socket.terminate();
}
