import type { IncomingMessage } from 'node:http';

import type { NestExpressApplication } from '@nestjs/platform-express';

/** Bound decompressed message JSON before buffering; preserve the existing defaults elsewhere. */
export function setupDialogBodyLimit(app: NestExpressApplication): void {
  const messages = (req: IncomingMessage): boolean =>
    req.method === 'POST' &&
    /^\/dialogs\/[^/]+\/messages\/?$/i.test((req.url ?? '').split('?')[0]!);
  const json = (req: IncomingMessage): boolean =>
    /^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '');

  app.useBodyParser('json', {
    limit: 65536,
    type: (req: IncomingMessage): boolean => messages(req) && json(req),
  });
  app.useBodyParser('json', {
    type: (req: IncomingMessage): boolean => !messages(req) && json(req),
  });
  app.useBodyParser('urlencoded', {
    extended: true,
    limit: 65536,
    type: (req: IncomingMessage): boolean =>
      /^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(req.headers['content-type'] ?? ''),
  });
}
