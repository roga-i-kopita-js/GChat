import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolve } from 'node:path';

import type { NestExpressApplication } from '@nestjs/platform-express';

/** Enable the server build only when an explicit deployment directory is configured. */
export function setupServerWeb(app: NestExpressApplication, directory: string | undefined): void {
  if (directory === undefined) return;

  if (!directory.trim()) throw new Error('GCHAT_WEB_ROOT must be a nonempty directory');

  const root = resolve(directory);
  const html = readFileSync(resolve(root, 'index.html'));

  app.use((req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    const path = req.url?.split('?')[0];
    const readable = req.method === 'GET' || req.method === 'HEAD';

    if (readable && path === '/') {
      res.writeHead(302, {
        Location: '/apps/client' + (req.url?.slice(1) ?? ''),
        'Cache-Control': 'no-store',
      });
      res.end();

      return;
    }

    if (readable && (path === '/apps/client' || path?.startsWith('/apps/client/'))) {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': html.length,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(req.method === 'HEAD' ? undefined : html);

      return;
    }

    next();
  });

  app.useStaticAssets(root, { prefix: '/apps/', index: false, dotfiles: 'deny' });
}
