import { jest } from '@jest/globals';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module.js';
import { AuthService } from '../src/auth/auth.service.js';
import { DATABASE_POOL } from '../src/database/database.constants.js';
import { DialogsCrypto } from '../src/dialogs/dialogs.crypto.js';
import { DirectCallsWorker } from '../src/direct-calls/direct-calls.worker.js';
import { PushClient } from '../src/push/push.client.js';
import { PushWorker } from '../src/push/push.worker.js';
import { REDIS_CLIENT } from '../src/redis/redis.constants.js';
import { SignalingAdapter } from '../src/signaling/signaling.adapter.js';
import { SignalingWorker } from '../src/signaling/signaling.worker.js';
import { setupSwagger } from '../src/swagger/setup-swagger.js';

describe('Backend HTTP', (): void => {
  let app: INestApplication;
  const pool = {
    query: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
    end: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  };

  const redis = {
    isOpen: true,
    connect: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    ping: jest.fn<() => Promise<string>>().mockResolvedValue('PONG'),
    close: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    destroy: jest.fn(),
  };

  beforeAll(async (): Promise<void> => {
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DialogsCrypto)
      .useValue({})
      .overrideProvider(DirectCallsWorker)
      .useValue({})
      .overrideProvider(SignalingWorker)
      .useValue({})
      .overrideProvider(PushWorker)
      .useValue({})
      .overrideProvider(PushClient)
      .useValue({})
      .overrideProvider(DATABASE_POOL)
      .useValue(pool)
      .overrideProvider(REDIS_CLIENT)
      .useValue(redis)
      .compile();

    app = module.createNestApplication();
    app.useWebSocketAdapter(new SignalingAdapter(app, module.get(AuthService)));
    setupSwagger(app);
    await app.init();
  });

  afterAll(async (): Promise<void> => {
    await app?.close();
    expect(pool.end).toHaveBeenCalledTimes(1);
    expect(redis.close).toHaveBeenCalledTimes(1);
  });

  beforeEach((): void => {
    redis.ping.mockReset().mockResolvedValue('PONG');
    pool.query.mockReset();
    pool.query.mockResolvedValue({ rows: [{ '?column?': 1 }] });
  });

  it('serves Swagger UI and controller-generated OpenAPI', async (): Promise<void> => {
    await request(app.getHttpServer())
      .get('/docs')
      .redirects(1)
      .expect(200)
      .expect(/swagger-ui/);
    const response = await request(app.getHttpServer()).get('/docs-json').expect(200);

    expect(response.body.info.title).toBe('GChat API');
    expect(Object.keys(response.body.paths).sort()).toEqual([
      '/admin/groups',
      '/admin/users',
      '/admin/users/{user_id}',
      '/admin/users/{user_id}/disable',
      '/admin/users/{user_id}/enable',
      '/admin/users/{user_id}/password',
      '/auth/login',
      '/auth/logout',
      '/auth/refresh',
      '/auth/ws-ticket',
      '/dialogs',
      '/dialogs/{dialog_id}',
      '/dialogs/{dialog_id}/messages',
      '/dialogs/{dialog_id}/permissions',
      '/dialogs/{dialog_id}/read',
      '/groups',
      '/groups/{group_id}/members',
      '/health',
      '/ready',
    ]);
    expect(response.body.paths['/health'].get).toBeDefined();
    expect(
      response.body.paths['/ready'].get.responses['503'].content['application/json'].schema,
    ).toEqual({ $ref: '#/components/schemas/ReadinessResponseDto' });
    expect(response.body.components.securitySchemes.bearer.scheme).toBe('bearer');
    expect(response.body.paths['/health'].get.security).toBeUndefined();
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('exposes a liveness endpoint without a database dependency', async (): Promise<void> => {
    await request(app.getHttpServer()).get('/health').expect(200).expect({
      status: 'ok',
      service: 'gchat-backend',
    });
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('checks PostgreSQL on every readiness request through Drizzle', async (): Promise<void> => {
    for (let i = 0; i < 2; i++) {
      await request(app.getHttpServer())
        .get('/ready')
        .expect(200)
        .expect({
          status: 'ok',
          service: 'gchat-backend',
          checks: { database: 'up', redis: 'up' },
        });
    }

    expect(pool.query).toHaveBeenCalledTimes(2);
    expect(pool.query.mock.calls[0]?.[0]).toMatchObject({ text: 'select 1' });
  });

  it('returns 503 without error details, keeps liveness up and recovers', async (): Promise<void> => {
    pool.query.mockRejectedValueOnce(new Error('connection failed: private-password'));
    await request(app.getHttpServer())
      .get('/ready')
      .expect(503)
      .expect({
        status: 'error',
        service: 'gchat-backend',
        checks: { database: 'down', redis: 'up' },
      });
    await request(app.getHttpServer()).get('/health').expect(200);
    expect(pool.query).toHaveBeenCalledTimes(1);
    await request(app.getHttpServer()).get('/ready').expect(200);
  });

  it('reports Redis failure without secrets and recovers', async (): Promise<void> => {
    redis.ping.mockRejectedValueOnce(new Error('private-redis-password'));
    await request(app.getHttpServer())
      .get('/ready')
      .expect(503)
      .expect({
        status: 'error',
        service: 'gchat-backend',
        checks: { database: 'up', redis: 'down' },
      });
    await request(app.getHttpServer()).get('/health').expect(200);
    await request(app.getHttpServer()).get('/ready').expect(200);
  });

  it('returns 404 for routes not implemented yet', async (): Promise<void> => {
    await request(app.getHttpServer()).get('/contacts').expect(404);
  });
});
