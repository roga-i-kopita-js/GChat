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

const { status: resultStatus } = await get('/api/ready');

assert.equal(resultStatus, 200);
const root = await fetch(base + '/?source=smoke', { redirect: 'manual' });

const { status: rootStatus } = root;

assert.equal(rootStatus, 302);
const { headers: rootHeaders } = root;

assert.equal(rootHeaders.get('location'), '/apps/client?source=smoke');
const htmlResponse = await get('/apps/client');

const { headers: htmlResponseHeaders } = htmlResponse;

assert.equal(htmlResponseHeaders.get('cache-control'), 'no-store');
const { text: htmlResponseText } = htmlResponse;
const html = await htmlResponseText.bind(htmlResponse)();

assert.match(html, /<html/);
const resolved = await get('/apps/client/admin/users?offset=0');
const { text: resultText } = resolved;

assert.equal(await resultText.bind(resolved)(), html);
const { matchAll: htmlMatchAll } = html;
const assets = [...htmlMatchAll.bind(html)(/(?:src|href)="(\/apps\/static\/[^"\s]+)"/g)];

assert.ok(assets.length > 0);

for (const [, asset] of assets) {
  const response = await get(asset);

  const { status: responseStatus } = response;

  assert.equal(responseStatus, 200);
  const { headers: responseHeaders } = response;

  assert.match(responseHeaders.get('cache-control') ?? '', /immutable/);
  const { headers: responseHeaders2 } = response;

  assert.doesNotMatch(responseHeaders2.get('content-type') ?? '', /text\/html/);
  const { arrayBuffer: responseArrayBuffer } = response;
  const { byteLength: resultByteLength } = await responseArrayBuffer.bind(response)();

  assert.ok(resultByteLength > 0);
}

for (const animal of ['cat', 'dog', 'fox', 'bear', 'bunny']) {
  const response = await get('/apps/static/dialog-stickers/animal-pals-v1-' + animal + '.png');

  const { status: responseStatus2 } = response;

  assert.equal(responseStatus2, 200);
  const { headers: responseHeaders3 } = response;

  assert.match(responseHeaders3.get('content-type') ?? '', /image\/png/);
  const { arrayBuffer: responseArrayBuffer2 } = response;
  const bytes = Buffer.from(await responseArrayBuffer2.bind(response)());

  assert.equal(bytes.readUInt32BE(16), 512);
  assert.equal(bytes.readUInt32BE(20), 512);
}

const worker = await get('/apps/sw.js');

const { status: workerStatus } = worker;

assert.equal(workerStatus, 200);
const { headers: workerHeaders } = worker;

assert.equal(workerHeaders.get('cache-control'), 'no-cache');
const { headers: workerHeaders2 } = worker;

assert.match(workerHeaders2.get('content-type') ?? '', /(?:text|application)\/javascript/);
const { text: workerText } = worker;

assert.match(await workerText.bind(worker)(), /gchat-shell-server-/);
const manifestResponse = await get('/apps/site.webmanifest');

const { status: manifestResponseStatus } = manifestResponse;

assert.equal(manifestResponseStatus, 200);
const { headers: manifestResponseHeaders } = manifestResponse;

assert.equal(manifestResponseHeaders.get('cache-control'), 'no-cache');
const { headers: manifestResponseHeaders2 } = manifestResponse;

assert.match(
  manifestResponseHeaders2.get('content-type') ?? '',
  /application\/(?:manifest\+json|json)/,
);
const { json: manifestResponseJson } = manifestResponse;
const manifest = await manifestResponseJson.bind(manifestResponse)();

const { id: manifestId } = manifest;

assert.equal(manifestId, '/apps/client');
const { scope: manifestScope } = manifest;

assert.equal(manifestScope, '/apps/client');
const { start_url: manifestStartUrl } = manifest;

assert.equal(manifestStartUrl, '/apps/client/calls');
const { display: manifestDisplay } = manifest;

assert.equal(manifestDisplay, 'standalone');
const { icons: manifestIcons } = manifest;

assert.ok(manifestIcons.length > 0);

const { icons: manifestIcons2 } = manifest;

for (const icon of manifestIcons2) {
  assert.match(icon.src, /^\/apps\/icons\/[a-zA-Z0-9_.-]+\.png$/);
  const response = await get(icon.src);

  const { status: responseStatus3 } = response;

  assert.equal(responseStatus3, 200);
  const { headers: responseHeaders4 } = response;

  assert.match(responseHeaders4.get('content-type') ?? '', /image\/png/);
  const { arrayBuffer: responseArrayBuffer3 } = response;
  const { byteLength: resultByteLength2 } = await responseArrayBuffer3.bind(response)();

  assert.ok(resultByteLength2 > 0);
}

const { status: resultStatus2 } = await get('/apps/static/missing.js');

assert.equal(resultStatus2, 404);
const { status: resultStatus3 } = await get('/unknown');

assert.equal(resultStatus3, 404);
const login = await fetch(base + '/api/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ login: 'release-smoke', password }),
});

const { status: loginStatus } = login;

assert.equal(loginStatus, 200);
const { json: loginJson } = login;
const tokens = await loginJson.bind(login)();
const { access_token: tokensAccessToken } = tokens;
const ticketResponse = await fetch(base + '/api/auth/ws-ticket', {
  method: 'POST',
  headers: {
    Authorization: 'Bearer ' + tokensAccessToken,
    Origin: origin,
    'Content-Type': 'application/json',
  },
  body: '{}',
});

const { status: ticketResponseStatus } = ticketResponse;

assert.equal(ticketResponseStatus, 200);
const { json: ticketResponseJson } = ticketResponse;
const { ticket } = await ticketResponseJson.bind(ticketResponse)();

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

  const { device_id: deviceDeviceId } = device;

  assert.equal(typeof deviceDeviceId, 'string');
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
    const { access_token: tokensAccessToken2 } = tokens;

    return fetch(base + '/api' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: 'Bearer ' + tokensAccessToken2,
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

  const { status: peerResponseStatus } = peerResponse;

  assert.equal(peerResponseStatus, 201);
  const { json: peerResponseJson } = peerResponse;
  const { user: resultUser } = await peerResponseJson.bind(peerResponse)();
  const peer = resultUser;
  const create = await api('/dialogs', { peer_id: peer.id });

  const { status: createStatus } = create;

  assert.equal(createStatus, 201);
  const { json: createJson } = create;
  const { dialog: resultDialog } = await createJson.bind(create)();
  const dialog = resultDialog;
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

  const { status: sentStatus } = sent;

  assert.equal(sentStatus, 201);
  assert.deepEqual(await available, {
    type: 'dialog.messages_available',
    payload: { dialog_id: dialog.dialog_id, last_sequence: 1 },
  });
  const { json: sentJson } = sent;
  const { message: resultMessage } = await sentJson.bind(sent)();
  const saved = resultMessage;
  const repeated = await api(path + '/messages', {
    ...body,
    content: { kind: 'text', text: 'not a replacement' },
  });

  const { status: repeatedStatus } = repeated;

  assert.equal(repeatedStatus, 200);
  const { json: repeatedJson } = repeated;
  const { message: resultMessage2 } = await repeatedJson.bind(repeated)();

  assert.deepEqual(resultMessage2, saved);
  const history = await api(path + '/messages?after_sequence=0');

  const { headers: historyHeaders } = history;

  assert.equal(historyHeaders.get('cache-control'), 'no-store');
  const { json: historyJson } = history;
  const { messages: resultMessages } = await historyJson.bind(history)();

  assert.deepEqual(resultMessages, [saved]);
  const resolved2 = await api(path + '/read', { sequence: 1 });
  const { json: resultJson } = resolved2;
  const { last_read_sequence: resultLastReadSequence } = await resultJson.bind(resolved2)();

  assert.equal(resultLastReadSequence, 1);
  const resolved3 = await api(path + '/read', { sequence: 0 });
  const { json: resultJson2 } = resolved3;
  const { last_read_sequence: resultLastReadSequence2 } = await resultJson2.bind(resolved3)();

  assert.equal(resultLastReadSequence2, 1);
  const resolved4 = await api(path + '/permissions');
  const { json: resultJson3 } = resolved4;
  const { dialogs: resultDialogs } = await resultJson3.bind(resolved4)();

  assert.deepEqual(resultDialogs, {
    can_read: true,
    can_send: true,
  });
  const huge = JSON.stringify({ ...body, content: { kind: 'text', text: 'x'.repeat(70000) } });

  for (const compressed of [false, true]) {
    const { access_token: tokensAccessToken3 } = tokens;
    const response = await fetch(base + '/api' + path + '/messages', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + tokensAccessToken3,
        'Content-Type': 'application/json',
        ...(compressed ? { 'Content-Encoding': 'gzip' } : {}),
      },
      body: compressed ? gzipSync(huge) : huge,
      signal: AbortSignal.timeout(10000),
    });

    const { status: responseStatus4 } = response;

    assert.equal(responseStatus4, 413);
    const { json: responseJson } = response;
    const { error: resultError } = await responseJson.bind(response)();

    assert.equal(resultError.code, 'PAYLOAD_TOO_LARGE');
  }
} finally {
  // No call is created, and this disposable subscription never receives a real push.
  if (registered && socket.readyState === WebSocket.OPEN) {
    await (async () => {
      try {
        return await command('device.web_push', { subscription: null });
      } catch (cause) {}
    })();
  }

  clearTimeout(timer);
  socket.terminate();
}
