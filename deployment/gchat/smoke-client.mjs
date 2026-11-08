// Runs only inside the disposable image smoke test; all credentials are ephemeral.
import assert from 'node:assert/strict';
import { createECDH, randomBytes, randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';

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

for (const animal of ['cat', 'dog', 'fox', 'bear', 'bunny']) {
  const response = await get('/apps/static/dialog-stickers/animal-pals-v1-' + animal + '.png');

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /image\/png/);
  const bytes = Buffer.from(await response.arrayBuffer());

  assert.equal(bytes.readUInt32BE(16), 512);
  assert.equal(bytes.readUInt32BE(20), 512);
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

  if (!operation) {
    return;
  }

  pending.delete(message.request_id);

  if (message.error) {
    operation.reject(new Error('Smoke WSS command rejected: ' + message.error.code));
  } else {
    operation.resolve(message.payload);
  }
});
socket.on('close', () => {
  for (const operation of pending.values()) {
    operation.reject(new Error('Smoke WSS closed'));
  }

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
  async function api(path, body) {
    return fetch(base + '/api' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: 'Bearer ' + tokens.access_token,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
  }
  const peerResponse = await api('/admin/users', {
    login: 'dialog-peer',
    display_name: 'Peer',
    group_name: 'dialog-smoke',
    password: randomBytes(32).toString('hex'),
  });

  assert.equal(peerResponse.status, 201);
  const peer = (await peerResponse.json()).user;
  const create = await api('/dialogs', { peer_id: peer.id });

  assert.equal(create.status, 201);
  const dialog = (await create.json()).dialog;
  const path = '/dialogs/' + dialog.dialog_id;
  const body = {
    client_message_id: randomUUID(),
    content: { kind: 'text', text: 'Smoke history 👋' },
  };
  const available = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off('message', receive);
      reject(new Error('No dialog event'));
    }, 3000);

    function receive(raw) {
      const frame = JSON.parse(raw.toString());

      if (frame.type !== 'dialog.messages_available') {
        return;
      }

      clearTimeout(timeout);
      socket.off('message', receive);
      resolve(frame);
    }
    socket.on('message', receive);
  });
  const sent = await api(path + '/messages', body);

  assert.equal(sent.status, 201);
  assert.deepEqual(await available, {
    type: 'dialog.messages_available',
    payload: { dialog_id: dialog.dialog_id, last_sequence: 1 },
  });
  const saved = (await sent.json()).message;
  const repeated = await api(path + '/messages', {
    ...body,
    content: { kind: 'text', text: 'not a replacement' },
  });

  assert.equal(repeated.status, 200);
  assert.deepEqual((await repeated.json()).message, saved);
  const history = await api(path + '/messages?after_sequence=0');

  assert.equal(history.headers.get('cache-control'), 'no-store');
  assert.deepEqual((await history.json()).messages, [saved]);
  assert.equal((await (await api(path + '/read', { sequence: 1 })).json()).last_read_sequence, 1);
  assert.equal((await (await api(path + '/read', { sequence: 0 })).json()).last_read_sequence, 1);
  assert.deepEqual((await (await api(path + '/permissions')).json()).dialogs, {
    can_read: true,
    can_send: true,
  });
  const huge = JSON.stringify({ ...body, content: { kind: 'text', text: 'x'.repeat(70000) } });

  for (const compressed of [false, true]) {
    const response = await fetch(base + '/api' + path + '/messages', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + tokens.access_token,
        'Content-Type': 'application/json',
        ...(compressed ? { 'Content-Encoding': 'gzip' } : {}),
      },
      body: compressed ? gzipSync(huge) : huge,
      signal: AbortSignal.timeout(10000),
    });

    assert.equal(response.status, 413);
    assert.equal((await response.json()).error.code, 'PAYLOAD_TOO_LARGE');
  }
} finally {
  // No call is created, and this disposable subscription never receives a real push.
  if (registered && socket.readyState === WebSocket.OPEN) {
    await command('device.web_push', { subscription: null }).catch(() => {});
  }

  clearTimeout(timer);
  socket.terminate();
}
