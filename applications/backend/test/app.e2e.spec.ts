import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { jest } from '@jest/globals';
import { AppModule } from '../src/app.module.js';
import { DATABASE_POOL } from '../src/database/database.constants.js';

describe('Backend HTTP', () => {
  let app: INestApplication;
  const pool = {
    query: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
    end: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DATABASE_POOL)
      .useValue(pool)
      .compile();
    app = module.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    expect(pool.end).toHaveBeenCalledTimes(1);
  });

  beforeEach(() => {
    pool.query.mockReset();
    pool.query.mockResolvedValue({ rows: [{ '?column?': 1 }] });
  });

  it('exposes a liveness endpoint without a database dependency', async () => {
    await request(app.getHttpServer()).get('/health').expect(200).expect({
      status: 'ok',
      service: 'gchat-backend',
    });
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('checks PostgreSQL on every readiness request through Drizzle', async () => {
    for (let i = 0; i < 2; i++) {
      await request(app.getHttpServer()).get('/ready').expect(200).expect({
        status: 'ok',
        service: 'gchat-backend',
        checks: { database: 'up' },
      });
    }
    expect(pool.query).toHaveBeenCalledTimes(2);
    expect(pool.query.mock.calls[0]?.[0]).toMatchObject({ text: 'select 1' });
  });

  it('returns 503 without error details, keeps liveness up and recovers', async () => {
    pool.query.mockRejectedValueOnce(new Error('connection failed: private-password'));
    await request(app.getHttpServer()).get('/ready').expect(503).expect({
      status: 'error',
      service: 'gchat-backend',
      checks: { database: 'down' },
    });
    await request(app.getHttpServer()).get('/health').expect(200);
    expect(pool.query).toHaveBeenCalledTimes(1);
    await request(app.getHttpServer()).get('/ready').expect(200);
  });

  it('returns 404 for routes not implemented yet', async () => {
    await request(app.getHttpServer()).get('/contacts').expect(404);
  });
});
