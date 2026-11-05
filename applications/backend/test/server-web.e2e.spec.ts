import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { setupServerWeb } from '../src/web/setup-server-web.js';

describe('Server Web delivery', (): void => {
  let app: NestExpressApplication;
  let root: string;

  beforeAll(async (): Promise<void> => {
    root = mkdtempSync(join(tmpdir(), 'gchat-web-'));
    mkdirSync(join(root, 'static'));
    mkdirSync(join(root, 'icons'));
    writeFileSync(join(root, 'sw.js'), 'self.addEventListener("push", () => {});');
    writeFileSync(join(root, 'site.webmanifest'), '{}');
    writeFileSync(join(root, 'index.html'), '<html>GChat client</html>');
    writeFileSync(join(root, 'static', 'client.js'), 'console.log("GChat");');
    writeFileSync(join(root, 'icons', 'icon.svg'), '<svg/>');
    const module = await Test.createTestingModule({}).compile();

    app = module.createNestApplication<NestExpressApplication>();
    setupServerWeb(app, root);
    await app.init();
  });

  afterAll(async (): Promise<void> => {
    await app?.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('redirects the public root while preserving query', async (): Promise<void> => {
    await request(app.getHttpServer())
      .get('/?source=link')
      .expect(302)
      .expect('Location', '/apps/client?source=link');
  });

  it('serves nested client routes without a redirect and without caching HTML', async (): Promise<void> => {
    await request(app.getHttpServer())
      .get('/apps/client/admin/users/example?q=name')
      .expect(200)
      .expect('Cache-Control', 'no-store')
      .expect('<html>GChat client</html>');
    await request(app.getHttpServer()).head('/apps/client/login').expect(200);
  });

  it('serves built assets and public files', async (): Promise<void> => {
    await request(app.getHttpServer())
      .get('/apps/static/client.js')
      .expect(200)
      .expect('Cache-Control', 'public, max-age=31536000, immutable')
      .expect(/console.log/);
    await request(app.getHttpServer()).get('/apps/icons/icon.svg').expect(200);
  });

  it('revalidates the worker and manifest without returning the SPA shell', async (): Promise<void> => {
    await request(app.getHttpServer())
      .get('/apps/sw.js')
      .expect(200)
      .expect('Cache-Control', 'no-cache')
      .expect(/self.addEventListener/);
    await request(app.getHttpServer())
      .get('/apps/site.webmanifest')
      .expect(200)
      .expect('Cache-Control', 'no-cache');
  });

  it.each(['/apps/static/missing.js', '/apps/icons/missing.svg', '/api/ready', '/ws', '/unknown'])(
    'does not return HTML for %s',
    async (path: string): Promise<void> => {
      await request(app.getHttpServer()).get(path).expect(404);
    },
  );

  it('rejects missing configured builds at startup', (): void => {
    expect((): void => setupServerWeb(app, join(root, 'missing'))).toThrow();
  });
});
