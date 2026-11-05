// A local production-shell fixture. It has no database, account or push credentials.
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve } from 'node:path';

let revision = 'one';
let incomplete = false;
const root = resolve('.local/pwa');
const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:5186');

  res.setHeader('Cache-Control', 'no-cache');

  if (url.pathname === '/__ready') return res.end('ready');

  if (url.pathname === '/__revision') {
    revision = url.searchParams.get('value') ?? 'one';
    incomplete = url.searchParams.has('incomplete');

    return res.end('ok');
  }

  const server = url.pathname.startsWith('/apps/');
  const path = server ? url.pathname.slice(6) : url.pathname.slice(1);

  if (path.includes('..') || path.startsWith('api/') || path === 'ws') {
    res.writeHead(404);

    return res.end();
  }

  const navigation = server
    ? /^client(?:\/|$)/.test(path)
    : /^(?:$|calls(?:\/|$)|login(?:\/|$)|admin(?:\/|$))/.test(path);
  const file = navigation ? 'index.html' : path;

  try {
    let content = await readFile(resolve(root, server ? 'server' : 'root', file));

    if (file === 'sw.js')
      content = Buffer.from(
        content.toString().replace(/(gchat-shell-(?:server|root)-[a-f0-9]+)/g, '$1-' + revision),
      );

    if (incomplete && file.endsWith('.js') && file !== 'sw.js') {
      res.writeHead(404);

      return res.end();
    }

    res.setHeader('Content-Type', types[extname(file)] ?? 'application/octet-stream');
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end();
  }
}).listen(5186, '127.0.0.1');
