// Standalone LAN fixture: no GChat accounts, database or production push credentials.
import { ECDH, X509Certificate } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:https';
import { createRequire } from 'node:module';
import { isIPv4 } from 'node:net';
import { extname } from 'node:path';

const requireBackend = createRequire(new URL('../../../backend/package.json', import.meta.url));
const webPush = requireBackend('web-push');
const host = process.env.GCHAT_SPIKE_HOST;

if (!isIPv4(host ?? '')) throw new Error('Set GCHAT_SPIKE_HOST to the Mac LAN IPv4 address');

const origin = `https://${host}:8444`;
const root = new URL('../../../web/dist/', import.meta.url);
const worker = await readFile(new URL('sw.js', root), 'utf8');

if (!worker.includes('"nativeLaunchSpike":true'))
  throw new Error('Build Web with VITE_GCHAT_IOS_LAUNCH_SPIKE=true first');

const vapid = webPush.generateVAPIDKeys();
const certificate = await readFile(process.env.GCHAT_SPIKE_CERT_FILE);
const authority = await readFile(process.env.GCHAT_SPIKE_CA_CERT_FILE);
const leaf = new X509Certificate(certificate);
const ca = new X509Certificate(authority);
const currentTime = Date.now();

if (
  leaf.ca ||
  !ca.ca ||
  !leaf.keyUsage?.includes('1.3.6.1.5.5.7.3.1') ||
  !leaf.checkIP(host) ||
  !leaf.verify(ca.publicKey) ||
  [leaf, ca].some(
    (cert) => Date.parse(cert.validFrom) > currentTime || Date.parse(cert.validTo) <= currentTime,
  )
)
  throw new Error(
    'Use a valid CA-signed server certificate with serverAuth EKU and matching IP SAN',
  );

let subscription;
let pending;
let status = { state: 'idle' };
const events = [];
const eventNames = new Set([
  'install',
  'activate',
  'push',
  'notificationclick',
  'page-ready',
  'page-visible',
  'intent-found',
]);
const diagnosticsWorker = `
for (const name of ['install', 'activate', 'push', 'notificationclick']) {
  self.addEventListener(name, (event) => {
    event.waitUntil(fetch('/spike/trace', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: name }),
    }).catch(() => {}));
  });
}
`;
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function validSubscription(value) {
  try {
    const url = new URL(value.endpoint);
    const key = value.keys?.p256dh;
    const auth = value.keys?.auth;

    return (
      value.endpoint.length <= 4096 &&
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.hash &&
      (url.hostname === 'web.push.apple.com' || url.hostname.endsWith('.push.apple.com')) &&
      typeof key === 'string' &&
      /^[A-Za-z0-9_-]{87}$/.test(key) &&
      typeof auth === 'string' &&
      /^[A-Za-z0-9_-]{22}$/.test(auth) &&
      Buffer.from(key, 'base64url')[0] === 4 &&
      ECDH.convertKey(Buffer.from(key, 'base64url'), 'prime256v1').length === 65
    );
  } catch {
    return false;
  }
}

async function send() {
  pending = undefined;
  status = { state: 'sending' };

  try {
    const result = await webPush.sendNotification(
      subscription,
      JSON.stringify({
        call_id: '00000000-0000-0000-0000-000000000001',
        ringing_deadline: new Date(Date.now() + 60000).toISOString(),
      }),
      {
        vapidDetails: { ...vapid, subject: 'mailto:launch-test@example.com' },
        TTL: 60,
        urgency: 'high',
        timeout: 5000,
      },
    );

    status = { state: 'provider-accepted', code: result.statusCode };
  } catch (cause) {
    // Never print provider bodies, subscription endpoints or keys.
    status = { state: 'provider-error', code: Number(cause.statusCode) || 0 };
  }
}

const server = createServer(
  {
    cert: certificate,
    key: await readFile(process.env.GCHAT_SPIKE_KEY_FILE),
    minVersion: 'TLSv1.2',
  },
  async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const json = (code, body) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    try {
      if (req.headers.host !== new URL(origin).host) return json(403, { error: 'host' });

      const { pathname } = new URL(req.url, origin);

      if (req.method === 'POST') {
        if (req.headers.origin !== origin || req.headers['content-type'] !== 'application/json')
          return json(403, { error: 'origin' });

        let data = '';

        for await (const part of req) {
          data += part;

          if (Buffer.byteLength(data) > 8192) return json(413, { error: 'size' });
        }

        if (pathname === '/spike/trace') {
          const value = JSON.parse(data);

          if (!eventNames.has(value.event)) return json(400, { error: 'event' });

          events.push({ event: value.event, at: new Date().toISOString() });

          if (events.length > 50) events.shift();

          return json(200, { state: 'recorded' });
        }

        if (pathname === '/spike/subscribe') {
          const value = JSON.parse(data);

          if (!validSubscription(value)) return json(400, { error: 'subscription' });

          if (pending || status.state === 'sending') return json(409, { error: 'busy' });

          subscription = { endpoint: value.endpoint, keys: value.keys };

          return json(200, { state: 'subscribed' });
        }

        if (pathname === '/spike/send' && subscription) {
          if (pending || status.state === 'sending') return json(409, { error: 'busy' });

          status = { state: 'scheduled' };
          pending = setTimeout(() => void send(), 10000);

          return json(202, status);
        }

        return json(404, { error: 'route' });
      }

      if (req.method !== 'GET') return json(405, { error: 'method' });

      if (pathname === '/spike/key') return json(200, { publicKey: vapid.publicKey });

      if (pathname === '/spike/status') return json(200, { ...status, events });

      const fixtures = {
        '/apps/launch-test': 'index.html',
        '/apps/launch-test.js': 'page.js',
        '/apps/launch-test.webmanifest': 'manifest.webmanifest',
      };
      let file;

      if (fixtures[pathname]) file = new URL(fixtures[pathname], import.meta.url);
      else if (pathname === '/apps/client' || pathname.startsWith('/apps/client/'))
        file = new URL('index.html', root);
      else if (
        /^\/apps\/(?:sw\.js|site\.webmanifest|favicon\.ico|apple-touch-icon\.png|(?:static|icons)\/[A-Za-z0-9_.-]+)$/.test(
          pathname,
        )
      )
        file = new URL(pathname.slice('/apps/'.length), root);
      else return json(404, { error: 'route' });

      let content = await readFile(file);

      if (pathname === '/apps/sw.js') content = Buffer.from(content.toString() + diagnosticsWorker);

      res.writeHead(200, {
        'Content-Type': types[extname(file.pathname)] ?? 'application/octet-stream',
      });
      res.end(content);
    } catch {
      if (!res.headersSent) json(400, { error: 'request' });
      else res.end();
    }
  },
);

server.listen(8444, host, () => console.log(`Local launch test: ${origin}/apps/launch-test`));

// Only the public test certificate is downloadable; never serve its private key.
createHttpServer((req, res) => {
  if (req.method !== 'GET' || req.url !== '/gchat-launch-test.cer') {
    res.writeHead(404);
    res.end();

    return;
  }

  res.writeHead(200, {
    'Content-Type': 'application/x-x509-ca-cert',
    'Content-Disposition': 'attachment; filename="gchat-launch-test.cer"',
    'Cache-Control': 'no-store',
  });
  res.end(ca.raw);
}).listen(8445, host);
