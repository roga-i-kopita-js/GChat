import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import type { INestApplication } from '@nestjs/common';
import { Controller, Get, UseGuards } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import pg from 'pg';
import { createClient } from 'redis';
import request from 'supertest';

import { AuthCrypto, sessionId, tokenHash } from '../src/auth/auth.crypto.js';
import type { TokensDto } from '../src/auth/auth.dto.js';
import { AuthGuard } from '../src/auth/auth.guard.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { AuthSessions } from '../src/auth/auth.sessions.js';
import { AuthWsTickets } from '../src/auth/auth.ws-tickets.js';
import { validateEnvironment } from '../src/config/environment.js';
import { runMigrations } from '../src/database/migrations.js';
import { ErrorModule } from '../src/error/error.module.js';
import { LoggerModule } from '../src/logger/logger.module.js';
import { RedisModule } from '../src/redis/redis.module.js';
import { RedisService } from '../src/redis/redis.service.js';

@Controller('private')
class PrivateController {
  @Get()
  @UseGuards(AuthGuard)
  protected(): { ok: boolean } {
    return { ok: true };
  }
}
const integration =
  process.env.AUTH_INTEGRATION_DATABASE_URL && process.env.AUTH_INTEGRATION_REDIS_URL
    ? describe
    : describe.skip;

integration('HTTP Auth with isolated PostgreSQL and Redis data', (): void => {
  const databaseName = `gchat_auth_${randomUUID().replaceAll('-', '')}`;
  const prefix = `gchat:auth-test:${randomUUID()}:`;
  const password = 'correct password with spaces';
  let app: INestApplication;
  let admin: pg.Pool;
  let database: pg.Pool;
  let redis: ReturnType<typeof createClient>;
  let passwordHash: string;
  let userId: string;
  let login: string;

  beforeAll(async (): Promise<void> => {
    admin = new pg.Pool({
      connectionString: process.env.AUTH_INTEGRATION_DATABASE_URL,
      connectionTimeoutMillis: 2000,
    });
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    const url = new URL(process.env.AUTH_INTEGRATION_DATABASE_URL!);

    url.pathname = `/${databaseName}`;
    database = new pg.Pool({ connectionString: url.href, connectionTimeoutMillis: 2000 });
    await runMigrations(url.href, resolve('drizzle'));
    // Reapplication must preserve the actual business schema.
    await runMigrations(url.href, resolve('drizzle'));
    redis = createClient({ url: process.env.AUTH_INTEGRATION_REDIS_URL });
    redis.on('error', (): void => {});
    await redis.connect();
    const settings = validateEnvironment({
      ...process.env,
      DATABASE_URL: url.href,
      REDIS_URL: process.env.AUTH_INTEGRATION_REDIS_URL,
      REDIS_KEY_PREFIX: prefix,
    });
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          validate: (): ReturnType<typeof validateEnvironment> => settings,
        }),
        LoggerModule.forRoot(),
        ErrorModule,
        RedisModule.forRoot(),
        AuthModule,
      ],
      controllers: [PrivateController],
    }).compile();

    app = module.createNestApplication();
    await app.listen(0, '127.0.0.1');
    passwordHash = await app.get(AuthCrypto).hashPassword(password);
  }, 20000);
  beforeEach(async (): Promise<void> => {
    userId = randomUUID();
    login = `user-${randomUUID().slice(0, 8)}`;
    await database.query(
      'INSERT INTO gchat_users (id, login, display_name, password_hash) VALUES ($1, $2, $3, $4)',
      [userId, login, 'Тест', passwordHash],
    );
  });
  afterAll(async (): Promise<void> => {
    await app?.close();

    if (redis?.isOpen) {
      try {
        for await (const keys of redis.scanIterator({ MATCH: `${prefix}*`, COUNT: 100 })) {
          if (keys.length) await redis.del(keys);
        }
      } finally {
        await redis.close();
      }
    }

    await database?.end();

    if (admin) {
      try {
        await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
      } finally {
        await admin.end();
      }
    }
  });
  async function signIn(): Promise<TokensDto> {
    return (
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ login, password })
        .expect(200)
        .expect('Cache-Control', 'no-store')
    ).body;
  }
  it('issues a bound browser ticket and atomically accepts it once', async (): Promise<void> => {
    const tokens = await signIn();
    const response = await request(app.getHttpServer())
      .post('/auth/ws-ticket')
      .auth(tokens.access_token, { type: 'bearer' })
      .set('Origin', 'http://localhost:5173')
      .send({})
      .expect(200)
      .expect('Cache-Control', 'no-store');
    const tickets = app.get(AuthWsTickets);
    const results = await Promise.allSettled([
      tickets.redeem(response.body.ticket, 'http://localhost:5173'),
      tickets.redeem(response.body.ticket, 'http://localhost:5173'),
    ]);

    expect(results.filter((result): boolean => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result): boolean => result.status === 'fulfilled')).toMatchObject({
      value: { userId, sessionId: sessionId(tokens.refresh_token) },
    });
    await request(app.getHttpServer())
      .post('/auth/ws-ticket')
      .auth(tokens.access_token, { type: 'bearer' })
      .set('Origin', 'https://foreign.invalid')
      .send({})
      .expect(403);
    await request(app.getHttpServer())
      .post('/auth/ws-ticket')
      .auth(tokens.access_token, { type: 'bearer' })
      .send({})
      .expect(403);
  });

  it('checks ticket origin, expiry, revocation and issue rate limits', async (): Promise<void> => {
    const tokens = await signIn();
    const tickets = app.get(AuthWsTickets);
    const issue = async (): Promise<any> =>
      (
        await request(app.getHttpServer())
          .post('/auth/ws-ticket')
          .auth(tokens.access_token, { type: 'bearer' })
          .set('Origin', 'http://localhost:5173')
          .send({})
          .expect(200)
      ).body;
    const wrong = await issue();

    await expect(tickets.redeem(wrong.ticket, 'http://127.0.0.1:5173')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    const expired = await issue();
    const { createHash } = await import('node:crypto');

    await redis.del(
      prefix + 'auth:ws-ticket:' + createHash('sha256').update(expired.ticket).digest('hex'),
    );
    await expect(tickets.redeem(expired.ticket, 'http://localhost:5173')).rejects.toMatchObject({
      code: 'ACCESS_TOKEN_INVALID',
    });
    const revoked = await issue();

    await request(app.getHttpServer())
      .post('/auth/logout')
      .send({ refresh_token: tokens.refresh_token })
      .expect(204);
    await expect(tickets.redeem(revoked.ticket, 'http://localhost:5173')).rejects.toMatchObject({
      code: 'SESSION_INVALID',
    });
    const another = await signIn();

    for (let i = 0; i < 10; i++)
      await request(app.getHttpServer())
        .post('/auth/ws-ticket')
        .auth(another.access_token, { type: 'bearer' })
        .set('Origin', 'http://localhost:5173')
        .send({})
        .expect(200);

    const limited = await request(app.getHttpServer())
      .post('/auth/ws-ticket')
      .auth(another.access_token, { type: 'bearer' })
      .set('Origin', 'http://localhost:5173')
      .send({})
      .expect(429);

    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('normalizes login, stores hashes, uses independent sessions and guards protected requests', async (): Promise<void> => {
    const first = (
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ login: ` ${login.toUpperCase()} `, password })
        .expect(200)
    ).body;
    const second = await signIn();

    expect(Object.keys(first).sort()).toEqual(['access_token', 'refresh_token', 'token_type']);
    expect(first.token_type).toBe('Bearer');
    const sid = sessionId(first.refresh_token)!;
    const saved = await redis.get(`${prefix}auth:session:${sid}`);

    expect(saved).not.toContain(first.refresh_token);
    expect(await redis.ttl(`${prefix}auth:session:${sid}`)).toBe(-1);
    expect(await redis.sMembers(`${prefix}auth:user-sessions:${userId}`)).toEqual(
      expect.arrayContaining([sid, sessionId(second.refresh_token)]),
    );
    await request(app.getHttpServer())
      .get('/private')
      .auth(first.access_token, { type: 'bearer' })
      .expect(200);
    await request(app.getHttpServer())
      .get('/private')
      .expect(401)
      .expect(({ body }): void => expect(body.error.code).toBe('ACCESS_TOKEN_INVALID'));
    await request(app.getHttpServer())
      .post('/auth/logout')
      .send({ refresh_token: first.refresh_token })
      .expect(204);
    await request(app.getHttpServer())
      .get('/private')
      .auth(first.access_token, { type: 'bearer' })
      .expect(401);
    await request(app.getHttpServer())
      .get('/private')
      .auth(second.access_token, { type: 'bearer' })
      .expect(200);
  });
  it('returns one encrypted rotation result to concurrent retries without counting them repeatedly', async (): Promise<void> => {
    const first = await signIn();
    const request_id = randomUUID();
    const replies = await Promise.all(
      Array.from({ length: 12 }, (): request.Test =>
        request(app.getHttpServer())
          .post('/auth/refresh')
          .send({ refresh_token: first.refresh_token, request_id })
          .expect(200),
      ),
    );

    for (const reply of replies) expect(reply.body).toEqual(replies[0]!.body);

    const sid = sessionId(first.refresh_token)!;

    expect(await redis.pTTL(`${prefix}auth:rotation:${sid}`)).toBeGreaterThan(0);
    expect(await redis.get(`${prefix}auth:rotation:${sid}`)).not.toContain(
      replies[0]!.body.refresh_token,
    );
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refresh_token: first.refresh_token, request_id: randomUUID() })
      .expect(401);
    const next = (
      await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refresh_token: replies[0]!.body.refresh_token, request_id: randomUUID() })
        .expect(200)
    ).body;

    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refresh_token: first.refresh_token, request_id })
      .expect(401);
    // An older, no longer recognized token must not delete the live session.
    await request(app.getHttpServer())
      .post('/auth/logout')
      .send({ refresh_token: first.refresh_token })
      .expect(204);
    await request(app.getHttpServer())
      .get('/private')
      .auth(next.access_token, { type: 'bearer' })
      .expect(200);
    await request(app.getHttpServer())
      .post('/auth/logout')
      .send({ refresh_token: replies[0]!.body.refresh_token })
      .expect(204);
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refresh_token: next.refresh_token, request_id: randomUUID() })
      .expect(401);
  }, 15000);
  it('rejects an expired rotation result without revoking the current session', async (): Promise<void> => {
    const first = await signIn();
    const request_id = randomUUID();
    const next = (
      await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refresh_token: first.refresh_token, request_id })
        .expect(200)
    ).body;
    const key = `${prefix}auth:rotation:${sessionId(first.refresh_token)}`;

    await redis.pExpire(key, 1);
    await new Promise((resolve): ReturnType<typeof setTimeout> => setTimeout(resolve, 10));
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refresh_token: first.refresh_token, request_id })
      .expect(401);
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refresh_token: next.refresh_token, request_id: randomUUID() })
      .expect(200);
  });
  it('checks account disablement immediately, including cached refresh responses', async (): Promise<void> => {
    const first = await signIn();
    const request_id = randomUUID();

    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refresh_token: first.refresh_token, request_id })
      .expect(200);
    await database.query('UPDATE gchat_users SET disabled_at = now() WHERE id = $1', [userId]);
    await request(app.getHttpServer())
      .get('/private')
      .auth(first.access_token, { type: 'bearer' })
      .expect(401)
      .expect(({ body }): void => expect(body.error.code).toBe('SESSION_INVALID'));
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refresh_token: first.refresh_token, request_id })
      .expect(401);
    const disabled = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ login, password })
      .expect(401);
    const unknown = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ login: 'unknown-user', password })
      .expect(401);

    expect(disabled.body).toEqual(unknown.body);
  });
  it('returns validation errors, no-store and Retry-After', async (): Promise<void> => {
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ login, password, unexpected: 'secret' })
      .expect(400)
      .expect('Cache-Control', 'no-store');
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refresh_token: 'unknown', request_id: 'bad' })
      .expect(400);

    for (let i = 0; i < 5; i++)
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ login, password: 'incorrect password' })
        .expect(401);

    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ login, password })
      .expect(429)
      .expect('Retry-After', /^\d+$/);
    await request(app.getHttpServer())
      .post('/auth/logout')
      .send({ refresh_token: 'unknown' })
      .expect(204);
  });
  it('limits new refresh operations and still allows the last retry', async (): Promise<void> => {
    let tokens = await signIn();
    let previous = tokens;
    let request_id = '';
    const reusedIds = [randomUUID(), randomUUID()];

    for (let i = 0; i < 10; i++) {
      previous = tokens;
      request_id = reusedIds[i % 2]!;
      tokens = (
        await request(app.getHttpServer())
          .post('/auth/refresh')
          .send({ refresh_token: tokens.refresh_token, request_id })
          .expect(200)
      ).body;
    }

    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refresh_token: tokens.refresh_token, request_id: randomUUID() })
      .expect(429);
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refresh_token: previous.refresh_token, request_id })
      .expect(200)
      .expect(({ body }): void => expect(body).toEqual(tokens));
  });
  it('allows current-token writes when a rotation snapshot expires but rejects conflicts', async (): Promise<void> => {
    const first = await signIn();
    const current = (
      await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refresh_token: first.refresh_token, request_id: randomUUID() })
        .expect(200)
    ).body as TokensDto;
    const sid = sessionId(current.refresh_token)!;
    const sessions = app.get(AuthSessions);
    const rotationKey = `${prefix}auth:rotation:${sid}`;

    await (async (): Promise<void> => {
      const before = (await sessions.read(sid))!;

      await redis.pExpire(rotationKey, 1);
      await new Promise<void>((resolve): void => {
        setTimeout(resolve, 10);
      });
      expect(await redis.get(rotationKey)).toBeNull();
      const next = { ...before.session, hash: 'replacement-hash' };
      const rotation = {
        requestId: randomUUID(),
        hash: before.session.hash,
        encrypted: 'test-result',
      };

      await sessions.mutate('rotate', sid, userId, before, next, rotation);
      expect((await sessions.read(sid))?.session.hash).toBe(next.hash);
      // A different live rotation must still fail the comparison without writing anything.
      const snapshot = (await sessions.read(sid))!;

      await redis.set(rotationKey, JSON.stringify({ ...rotation, requestId: randomUUID() }));
      expect(await sessions.mutate('rotate', sid, userId, snapshot, before.session, rotation)).toBe(
        false,
      );
      expect((await sessions.read(sid))?.session.hash).toBe(next.hash);
    })();
  });
  it.each(['current', 'previous'])(
    'handles expired rotation during logout with the %s token',
    async (which): Promise<void> => {
      const first = await signIn();
      const current = (
        await request(app.getHttpServer())
          .post('/auth/refresh')
          .send({ refresh_token: first.refresh_token, request_id: randomUUID() })
          .expect(200)
      ).body as TokensDto;
      const sid = sessionId(current.refresh_token)!;
      const sessions = app.get(AuthSessions);

      await (async (): Promise<void> => {
        const before = (await sessions.read(sid))!;

        await redis.pExpire(`${prefix}auth:rotation:${sid}`, 1);
        await new Promise<void>((resolve): void => {
          setTimeout(resolve, 10);
        });
        expect(await redis.get(`${prefix}auth:rotation:${sid}`)).toBeNull();
        const hash = tokenHash(which === 'current' ? current.refresh_token : first.refresh_token);

        await sessions.mutate('delete', sid, userId, before, undefined, undefined, hash);
        expect(Boolean(await sessions.read(sid))).toBe(which === 'previous');
        expect(Boolean(await redis.sIsMember(`${prefix}auth:user-sessions:${userId}`, sid))).toBe(
          which === 'previous',
        );
      })();
    },
  );
  it.each(['session', 'rotation'])(
    'returns 503 for a wrong-type %s key without reporting logout success',
    async (kind): Promise<void> => {
      const tokens = await signIn();
      const sid = sessionId(tokens.refresh_token)!;
      const key = `${prefix}auth:${kind}:${sid}`;
      const saved = await redis.get(key);

      await redis.del(key);
      await redis.hSet(key, 'unexpected', 'data');

      try {
        await request(app.getHttpServer())
          .get('/private')
          .auth(tokens.access_token, { type: 'bearer' })
          .expect(503)
          .expect(({ body }): void => {
            expect(body.error.code).toBe('SERVICE_UNAVAILABLE');
          });
        await request(app.getHttpServer())
          .post('/auth/refresh')
          .send({ refresh_token: tokens.refresh_token, request_id: randomUUID() })
          .expect(503);
        await request(app.getHttpServer())
          .post('/auth/logout')
          .send({ refresh_token: tokens.refresh_token })
          .expect(503);
        expect(await redis.hGet(key, 'unexpected')).toBe('data');
        expect(Boolean(await redis.sIsMember(`${prefix}auth:user-sessions:${userId}`, sid))).toBe(
          true,
        );
      } finally {
        await redis.del(key);

        if (saved !== null) await redis.set(key, saved);
      }

      await request(app.getHttpServer())
        .get('/private')
        .auth(tokens.access_token, { type: 'bearer' })
        .expect(200);
    },
  );
  it('keeps tokens valid through Redis unavailability and recovers without a new login', async (): Promise<void> => {
    const tokens = await signIn();
    const client = app.get(RedisService).client;

    client.destroy();

    try {
      await request(app.getHttpServer())
        .get('/private')
        .auth(tokens.access_token, { type: 'bearer' })
        .expect(503);
      await request(app.getHttpServer())
        .post('/auth/logout')
        .send({ refresh_token: tokens.refresh_token })
        .expect(503);
      await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refresh_token: tokens.refresh_token, request_id: randomUUID() })
        .expect(503);
    } finally {
      await client.connect();
    }

    await request(app.getHttpServer())
      .get('/private')
      .auth(tokens.access_token, { type: 'bearer' })
      .expect(200);
  });
  it('fails closed on a broken session index', async (): Promise<void> => {
    await redis.set(`${prefix}auth:user-sessions:${userId}`, 'wrong-type');
    await request(app.getHttpServer()).post('/auth/login').send({ login, password }).expect(503);
    expect(await redis.get(`${prefix}auth:user-sessions:${userId}`)).toBe('wrong-type');
  });
  it('allows only one of two different refresh operations with the same token', async (): Promise<void> => {
    const tokens = await signIn();
    const responses = await Promise.all(
      [randomUUID(), randomUUID()].map((request_id): PromiseLike<request.Response> =>
        request(app.getHttpServer())
          .post('/auth/refresh')
          .send({ refresh_token: tokens.refresh_token, request_id }),
      ),
    );

    expect(responses.map((response): number => response.status).sort()).toEqual([200, 401]);
    const winner = responses.find((response): boolean => response.status === 200)!;

    await request(app.getHttpServer())
      .get('/private')
      .auth(winner.body.access_token, { type: 'bearer' })
      .expect(200);
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refresh_token: winner.body.refresh_token, request_id: randomUUID() })
      .expect(200);
  });
  it('does not resurrect a session when refresh races logout', async (): Promise<void> => {
    const tokens = await signIn();
    const [refresh] = await Promise.all([
      request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refresh_token: tokens.refresh_token, request_id: randomUUID() }),
      request(app.getHttpServer())
        .post('/auth/logout')
        .send({ refresh_token: tokens.refresh_token })
        .expect(204),
    ]);

    expect([200, 401]).toContain(refresh.status);
    expect(await redis.get(`${prefix}auth:session:${sessionId(tokens.refresh_token)}`)).toBeNull();
    await request(app.getHttpServer())
      .get('/private')
      .auth(tokens.access_token, { type: 'bearer' })
      .expect(401);
  });
});
