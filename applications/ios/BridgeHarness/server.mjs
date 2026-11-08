// Isolated HTTPS test host. No real accounts or credentials are created by this process.
import { appendFile, readFile, rename, stat } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';

import { validateEvent } from './telemetry.mjs';

const journal =
  process.env.GCHAT_BRIDGE_EVENTS_FILE ?? join(tmpdir(), 'gchat-bridge-manual-events.jsonl');
let journalWrites = Promise.resolve();
const seen = new Set();
const schema = await readFile(new URL('telemetry.mjs', import.meta.url));

const host = process.env.GCHAT_BRIDGE_HOST ?? '127.0.0.1';
const port = Number(process.env.GCHAT_BRIDGE_PORT ?? 8446);
const backend = process.env.GCHAT_BRIDGE_BACKEND ? new URL(process.env.GCHAT_BRIDGE_BACKEND) : null;

if (
  backend &&
  (backend.protocol !== 'http:' ||
    backend.hostname !== '127.0.0.1' ||
    backend.pathname !== '/' ||
    backend.username ||
    backend.password ||
    backend.search ||
    backend.hash)
) {
  throw new Error(
    'GCHAT_BRIDGE_BACKEND must be a loopback HTTP origin of an isolated test backend',
  );
}

const clientRoot = process.env.GCHAT_BRIDGE_CLIENT_ROOT
  ? resolve(process.env.GCHAT_BRIDGE_CLIENT_ROOT)
  : null;

if (clientRoot && !backend) {
  throw new Error('Client smoke requires the isolated backend');
}

const clientHtml = clientRoot ? await readFile(join(clientRoot, 'index.html')) : null;
const html = (await readFile(new URL('index.html', import.meta.url), 'utf8')).replace(
  '<html lang="ru">',
  `<html lang="ru" data-autorun="${process.env.GCHAT_BRIDGE_AUTORUN === '1'}" data-storage-autorun="${process.env.GCHAT_BRIDGE_STORAGE_AUTORUN === '1'}" data-navigation-autorun="${process.env.GCHAT_BRIDGE_NAVIGATION_AUTORUN === '1'}">`,
);
const js = await readFile(new URL('page.js', import.meta.url));
const server = createServer(
  {
    cert: await readFile(process.env.GCHAT_BRIDGE_CERT_FILE),
    key: await readFile(process.env.GCHAT_BRIDGE_KEY_FILE),
    minVersion: 'TLSv1.2',
  },
  async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const pathname = new URL(req.url, 'https://localhost').pathname;

    if (
      req.method === 'GET' &&
      (pathname === '/apps/client' || pathname.startsWith('/apps/client/'))
    ) {
      if (process.env.GCHAT_BRIDGE_AUTORUN === '1') {
        console.log('Bridge smoke: document loaded');
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(clientHtml ?? html);

      return;
    }

    if (clientRoot && req.method === 'GET' && pathname.startsWith('/apps/')) {
      try {
        const file = resolve(clientRoot, decodeURIComponent(pathname.slice('/apps/'.length)));
        const types = {
          '.js': 'text/javascript',
          '.css': 'text/css',
          '.png': 'image/png',
          '.svg': 'image/svg+xml',
          '.ico': 'image/x-icon',
          '.webmanifest': 'application/manifest+json',
          '.woff2': 'font/woff2',
        };

        if (!file.startsWith(clientRoot + sep) || !types[extname(file)]) {
          throw new Error('Unsupported asset');
        }

        const data = await readFile(file);

        res.writeHead(200, { 'Content-Type': types[extname(file)] });
        res.end(data);
      } catch {
        res.writeHead(404);
        res.end();
      }

      return;
    }

    if (req.method === 'GET' && pathname === '/apps/static/bridge-harness.js') {
      if (process.env.GCHAT_BRIDGE_AUTORUN === '1') {
        console.log('Bridge smoke: script loaded');
      }

      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
      res.end(js);

      return;
    }

    if (req.method === 'GET' && pathname === '/apps/static/bridge-telemetry.mjs') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
      res.end(schema);

      return;
    }

    if (req.method === 'GET' && pathname === '/apps/static/bridge-navigation.js') {
      try {
        const bundle = await readFile(new URL('dist/navigation.js', import.meta.url));

        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
        res.end(bundle);
      } catch {
        res.writeHead(404);
        res.end();
      }

      return;
    }

    if (req.method === 'POST' && pathname === '/api/bridge-fixture/manual') {
      try {
        let body = '';

        for await (const part of req) {
          body += part;

          if (Buffer.byteLength(body) > 4096) {
            res.writeHead(413);
            res.end();

            return;
          }
        }

        const event = JSON.parse(body);

        if (!validateEvent(event)) {
          res.writeHead(400);
          res.end();

          return;
        }

        if (!seen.has(event.eventId)) {
          const record = { at: new Date().toISOString(), ...event };
          const write = journalWrites.then(async () => {
            const size = (await stat(journal).catch(() => null))?.size ?? 0;

            if (size > 1024 * 1024) {
              await rename(journal, journal + '.previous');
            }

            await appendFile(journal, JSON.stringify(record) + '\n', { mode: 0o600 });
          });

          journalWrites = write.catch(() => {});
          await write;
          seen.add(event.eventId);

          if (seen.size > 1000) {
            seen.delete(seen.values().next().value);
          }

          console.log(`MANUAL ${record.action} ${record.phase} ${JSON.stringify(record.metrics)}`);
        }

        res.writeHead(204);
        res.end();
      } catch {
        res.writeHead(400);
        res.end();
      }

      return;
    }

    if (req.method === 'POST' && pathname === '/api/bridge-fixture/report') {
      let body = '';

      req.on('data', (part) => {
        body += part;

        if (body.length > 256) {
          req.destroy();
        }
      });
      req.on('end', () => {
        try {
          const result = JSON.parse(body);

          if (
            !Number.isInteger(result.total) ||
            !Number.isInteger(result.passed) ||
            result.total < 1 ||
            result.total > 100 ||
            result.passed < 0 ||
            result.passed > result.total
          ) {
            throw new Error('Invalid report');
          }

          console.log(`Bridge HTTP smoke: ${result.passed}/${result.total} passed`);
          res.writeHead(204);
          res.end();
        } catch {
          res.writeHead(400);
          res.end();
        }
      });

      return;
    }

    if (pathname.startsWith('/api/bridge-fixture/')) {
      if (!['GET', 'HEAD'].includes(req.method)) {
        res.writeHead(405);
        res.end();

        return;
      }

      switch (pathname.slice('/api/bridge-fixture/'.length)) {
        case 'bytes':
          res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Set-Cookie': 'bridgeFixture=1; Secure',
          });
          res.end(Buffer.from([0, 1, 2, 255]));

          return;
        case 'head-large':
          res.writeHead(200, { 'Content-Length': 8 * 1024 * 1024 + 1 });
          res.end();

          return;
        case 'not-modified-large':
          res.writeHead(304, { 'Content-Length': 8 * 1024 * 1024 + 1 });
          res.end();

          return;
        case 'empty':
          res.writeHead(204);
          res.end();

          return;
        case 'error':
          res.writeHead(422);
          res.end('{"fixture":true}');

          return;
        case 'redirect':
          res.writeHead(302, { Location: '/api/bridge-fixture/bytes' });
          res.end();

          return;
        case 'large': {
          // Unknown content length exercises incremental native buffering.
          let count = 0;
          const chunk = Buffer.alloc(64 * 1024);
          const write = () => {
            while (count < 129) {
              count++;

              if (!res.write(chunk)) {
                res.once('drain', write);

                return;
              }
            }

            res.end();
          };

          write();

          return;
        }
        case 'slow': {
          const timer = setTimeout(() => {
            res.writeHead(200);
            res.end('delayed');
          }, 5000);

          res.on('close', () => clearTimeout(timer));

          return;
        }
        default:
          res.writeHead(404);
          res.end();

          return;
      }
    }

    if (!backend || !pathname.startsWith('/api/')) {
      res.writeHead(404);
      res.end();

      return;
    }

    const incoming = new URL(req.url, 'https://localhost');
    const destination = new URL(backend);

    destination.pathname = incoming.pathname.slice('/api'.length);
    destination.search = incoming.search;
    const upstream = httpRequest(
      destination,
      {
        method: req.method,
        headers: { ...req.headers, host: backend.host },
      },
      (response) => {
        res.writeHead(response.statusCode, response.headers);
        response.pipe(res);
      },
    );

    upstream.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(502);
      }

      res.end();
    });
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  },
);

// The existing native WSS remains the only signaling connection.
server.on('upgrade', (req, socket, head) => {
  if (!backend || new URL(req.url, 'https://localhost').pathname !== '/ws') {
    socket.destroy();

    return;
  }

  const incoming = new URL(req.url, 'https://localhost');
  const upstream = httpRequest(new URL(incoming.pathname + incoming.search, backend), {
    headers: { ...req.headers, host: backend.host },
  });

  upstream.on('upgrade', (response, peer, peerHead) => {
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\n${Object.entries(response.headers)
        .map(([key, value]) => `${key}: ${value}`)
        .join('\r\n')}\r\n\r\n`,
    );

    if (head.length) {
      peer.write(head);
    }

    if (peerHead.length) {
      socket.write(peerHead);
    }

    peer.pipe(socket);
    socket.pipe(peer);
    peer.on('error', () => socket.destroy());
    socket.on('error', () => peer.destroy());
    socket.on('close', () => peer.destroy());
    peer.on('close', () => socket.destroy());
  });
  upstream.on('response', () => socket.destroy());
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
  upstream.end();
});
server.listen(port, host, () => console.log(`Bridge harness listening on HTTPS port ${port}`));
