// Manual iPhone audio stand. Uses only the isolated E2E database and credentials.
import { spawn } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { isIPv4 } from 'node:net';
import { fileURLToPath } from 'node:url';

const host = process.env.GCHAT_IOS_LAN_IP;

if (!isIPv4(host ?? '')) throw new Error('Set GCHAT_IOS_LAN_IP to Mac LAN IPv4');

const component = process.argv[2];
const backendOrigin = 'http://127.0.0.1:3300';

function child(command, args, cwd, env) {
  const processChild = spawn(command, args, { cwd, env, stdio: 'inherit' });

  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => processChild.kill(signal));

  processChild.on('exit', (code) => {
    process.exitCode = code ?? 1;
  });
}

if (component === 'backend') {
  const settings = JSON.parse(
    await readFile(new URL('../.local/backend.json', import.meta.url), 'utf8'),
  );

  const database = new URL(settings.DATABASE_URL);

  if (
    database.hostname !== '127.0.0.1' ||
    database.port !== '55439' ||
    database.pathname !== '/gchat_web_test' ||
    settings.REDIS_URL !== 'redis://127.0.0.1:56389/0' ||
    settings.REDIS_KEY_PREFIX !== 'gchat:web-test:'
  )
    throw new Error('Refusing non-E2E database settings');

  child(
    process.execPath,
    ['dist/main.js'],
    fileURLToPath(new URL('../../../applications/backend/', import.meta.url)),
    {
      ...process.env,
      ...settings,
      APNS_ENABLED: 'false',
      WEB_PUSH_ENABLED: 'false',
      HOST: '127.0.0.1',
      PORT: '3300',
      AUTH_ACCESS_TOKEN_TTL_SECONDS: '120',
      SIGNALING_BROWSER_ORIGINS: JSON.stringify(['http://127.0.0.1:5187']),
      DIRECT_CALLS_TURN_URLS: JSON.stringify([
        `turn:${host}:33480?transport=udp`,
        `turn:${host}:33480?transport=tcp`,
      ]),
      DIRECT_CALLS_TURN_SHARED_SECRET: 'gchat_web_test_turn_only',
      DIRECT_CALLS_RINGING_TIMEOUT_SECONDS: '60',
      DIRECT_CALLS_CONNECTING_TIMEOUT_SECONDS: '30',
      DIRECT_CALLS_RECONNECT_TIMEOUT_SECONDS: '30',
    },
  );
} else if (component === 'peer') {
  child(
    'pnpm',
    ['--filter', '@gchat/web', 'dev', '--port', '5187'],
    fileURLToPath(new URL('../../../', import.meta.url)),
    {
      ...process.env,
      GCHAT_BACKEND_URL: backendOrigin,
      VITE_GCHAT_RUNTIME: 'browser',
      VITE_GCHAT_IOS_LAUNCH_SPIKE: 'false',
    },
  );
} else if (component === 'https') {
  const cert = await readFile(process.env.GCHAT_IOS_TLS_CERT);
  const parsed = new X509Certificate(cert);

  if (parsed.ca || !parsed.checkIP(host) || !parsed.keyUsage?.includes('1.3.6.1.5.5.7.3.1'))
    throw new Error('Use a serverAuth certificate with matching IP SAN, not a CA certificate');

  const server = https.createServer(
    { cert, key: await readFile(process.env.GCHAT_IOS_TLS_KEY), minVersion: 'TLSv1.2' },
    (req, res) => {
      const path = req.url ?? '';

      if (req.headers.host !== `${host}:8446` || !(path.startsWith('/api/') || path === '/ready')) {
        res.writeHead(404);
        res.end();

        return;
      }

      const request = http.request(
        new URL(path === '/ready' ? path : path.slice(4), backendOrigin),
        {
          method: req.method,
          headers: { ...req.headers, host: '127.0.0.1:3300' },
        },
        (response) => {
          res.writeHead(response.statusCode, response.headers);
          response.pipe(res);
        },
      );

      request.on('error', () => {
        if (!res.headersSent) res.writeHead(502);

        res.end();
      });
      req.pipe(request);
    },
  );

  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/ws' || req.headers.host !== `${host}:8446`) {
      socket.destroy();

      return;
    }

    const upstream = http.request(new URL('/ws', backendOrigin), {
      headers: { ...req.headers, host: '127.0.0.1:3300' },
    });

    upstream.on('upgrade', (response, peer, peerHead) => {
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
          Object.entries(response.headers)
            .map(([key, value]) => `${key}: ${value}\r\n`)
            .join('') +
          '\r\n',
      );

      if (peerHead.length) socket.write(peerHead);

      if (head.length) peer.write(head);

      socket.pipe(peer);
      peer.pipe(socket);
      socket.on('error', () => peer.destroy());
      peer.on('error', () => socket.destroy());
    });
    upstream.on('response', (response) => {
      socket.end(`HTTP/1.1 ${response.statusCode} Rejected\r\nConnection: close\r\n\r\n`);
      response.resume();
    });
    upstream.on('error', () => socket.destroy());
    upstream.end();
  });
  server.listen(8446, host, () => console.log(`iPhone test backend: https://${host}:8446`));
} else throw new Error('Choose backend, peer or https');
