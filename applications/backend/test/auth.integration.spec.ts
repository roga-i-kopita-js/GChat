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

    const { createNestApplication: moduleCreateNestApplication } = module;

    app = moduleCreateNestApplication.bind(module)();
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
          if (keys.length) {
            await redis.del(keys);
          }
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
    const { body: expectResultBody } = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ login, password })
      .expect(200)
      .expect('Cache-Control', 'no-store');

    return expectResultBody;
  }
  it('issues a bound browser ticket and atomically accepts it once', async (): Promise<void> => {
    const tokens = await signIn();
    const { access_token: tokensAccessToken } = tokens;
    const response = await request(app.getHttpServer())
      .post('/auth/ws-ticket')
      .auth(tokensAccessToken, { type: 'bearer' })
      .set('Origin', 'http://localhost:5173')
      .send({})
      .expect(200)
      .expect('Cache-Control', 'no-store');
    const tickets = app.get(AuthWsTickets);
    const { body: responseBody } = response;
    const results = await Promise.allSettled([
      tickets.redeem(responseBody.ticket, 'http://localhost:5173'),
      tickets.redeem(responseBody.ticket, 'http://localhost:5173'),
    ]);

    const { filter: resultsFilter } = results;

    expect(
      resultsFilter.bind(results)((result): boolean => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const { find: resultsFind } = results;
    const { refresh_token: tokensRefreshToken } = tokens;

    expect(
      resultsFind.bind(results)((result): boolean => result.status === 'fulfilled'),
    ).toMatchObject({
      value: { userId, sessionId: sessionId(tokensRefreshToken) },
    });
    const { access_token: tokensAccessToken2 } = tokens;

    await request(app.getHttpServer())
      .post('/auth/ws-ticket')
      .auth(tokensAccessToken2, { type: 'bearer' })
      .set('Origin', 'https://foreign.invalid')
      .send({})
      .expect(403);
    const { access_token: tokensAccessToken3 } = tokens;

    await request(app.getHttpServer())
      .post('/auth/ws-ticket')
      .auth(tokensAccessToken3, { type: 'bearer' })
      .send({})
      .expect(403);
  });

  it('checks ticket origin, expiry, revocation and issue rate limits', async (): Promise<void> => {
    const tokens = await signIn();
    const tickets = app.get(AuthWsTickets);
    const issue = async (): Promise<any> => {
      const { access_token: tokensAccessToken4 } = tokens;
      const { body: expectResultBody4 } = await request(app.getHttpServer())
        .post('/auth/ws-ticket')
        .auth(tokensAccessToken4, { type: 'bearer' })
        .set('Origin', 'http://localhost:5173')
        .send({})
        .expect(200);

      return expectResultBody4;
    };
    const { ticket: wrongTicket } = await issue();

    await expect(tickets.redeem(wrongTicket, 'http://127.0.0.1:5173')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    const expired = await issue();
    const { createHash } = await import('node:crypto');

    const { ticket: expiredTicket } = expired;

    await database.query(
      "UPDATE gchat_auth_ws_tickets SET issued_at=clock_timestamp()-interval '31 seconds', expires_at=clock_timestamp()-interval '1 second' WHERE ticket_hash=$1",
      [createHash('sha256').update(expiredTicket).digest('hex')],
    );
    const { ticket: expiredTicket2 } = expired;

    await expect(tickets.redeem(expiredTicket2, 'http://localhost:5173')).rejects.toMatchObject({
      code: 'ACCESS_TOKEN_INVALID',
    });
    const revoked = await issue();

    const { refresh_token: tokensRefreshToken2 } = tokens;

    await request(app.getHttpServer())
      .post('/auth/logout')
      .send({ refresh_token: tokensRefreshToken2 })
      .expect(204);
    const { ticket: revokedTicket } = revoked;

    await expect(tickets.redeem(revokedTicket, 'http://localhost:5173')).rejects.toMatchObject({
      code: 'ACCESS_TOKEN_INVALID',
    });
    const another = await signIn();

    for (let i = 0; i < 10; i++) {
      const { access_token: anotherAccessToken } = another;

      await request(app.getHttpServer())
        .post('/auth/ws-ticket')
        .auth(anotherAccessToken, { type: 'bearer' })
        .set('Origin', 'http://localhost:5173')
        .send({})
        .expect(200);
    }

    const { access_token: anotherAccessToken2 } = another;
    const { headers: limitedHeaders } = await request(app.getHttpServer())
      .post('/auth/ws-ticket')
      .auth(anotherAccessToken2, { type: 'bearer' })
      .set('Origin', 'http://localhost:5173')
      .send({})
      .expect(429);

    expect(Number(limitedHeaders['retry-after'])).toBeGreaterThan(0);
  });

  it('normalizes login, stores hashes, uses independent sessions and guards protected requests', async (): Promise<void> => {
    const { body: expectResultBody2 } = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ login: ` ${login.toUpperCase()} `, password })
      .expect(200);
    const first = expectResultBody2;
    const second = await signIn();

    expect(Object.keys(first).sort()).toEqual(['access_token', 'refresh_token', 'token_type']);
    expect(first.token_type).toBe('Bearer');
    const sid = sessionId(first.refresh_token)!;
    const { rows: queryResultRows } = await database.query(
      'SELECT * FROM gchat_auth_sessions WHERE id=$1',
      [sid],
    );
    const saved = queryResultRows[0];

    expect(saved.refresh_token_hash).toBe(tokenHash(first.refresh_token));
    expect(JSON.stringify(saved)).not.toContain(first.refresh_token);
    const { rows: queryResultRows2 } = await database.query(
      'SELECT id FROM gchat_auth_sessions WHERE user_id=$1',
      [userId],
    );
    const { refresh_token: secondRefreshToken } = second;

    expect(queryResultRows2.map((row): any => row.id)).toEqual(
      expect.arrayContaining([sid, sessionId(secondRefreshToken)]),
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
    const { access_token: secondAccessToken } = second;

    await request(app.getHttpServer())
      .get('/private')
      .auth(secondAccessToken, { type: 'bearer' })
      .expect(200);
  });
  it('returns one encrypted rotation result to concurrent retries without counting them repeatedly', async (): Promise<void> => {
    const first = await signIn();
    const request_id = randomUUID();
    const replies = await Promise.all(
      Array.from({ length: 12 }, (): request.Test => {
        const { refresh_token: firstRefreshToken } = first;

        return request(app.getHttpServer())
          .post('/auth/refresh')
          .send({ refresh_token: firstRefreshToken, request_id })
          .expect(200);
      }),
    );

    for (const reply of replies) {
      const { [0]: repliesFirst } = replies;

      expect(reply.body).toEqual(repliesFirst!.body);
    }

    const { refresh_token: firstRefreshToken2 } = first;
    const sid = sessionId(firstRefreshToken2)!;

    const { rows: queryResultRows3 } = await database.query(
      'SELECT rotation_expires_at, rotation_encrypted FROM gchat_auth_sessions WHERE id=$1',
      [sid],
    );
    const saved = queryResultRows3[0];

    expect(saved.rotation_expires_at.getTime()).toBeGreaterThan(Date.now());
    const { [0]: repliesFirst2 } = replies;

    expect(saved.rotation_encrypted).not.toContain(repliesFirst2!.body.refresh_token);
    const { refresh_token: firstRefreshToken3 } = first;

    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refresh_token: firstRefreshToken3, request_id: randomUUID() })
      .expect(401);
    const { [0]: repliesFirst3 } = replies;
    const { body: expectResultBody5 } = await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refresh_token: repliesFirst3!.body.refresh_token, request_id: randomUUID() })
      .expect(200);
    const next = expectResultBody5;

    const { refresh_token: firstRefreshToken4 } = first;

    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refresh_token: firstRefreshToken4, request_id })
      .expect(401);
    // An older, no longer recognized token must not delete the live session.
    const { refresh_token: firstRefreshToken5 } = first;

    await request(app.getHttpServer())
      .post('/auth/logout')
      .send({ refresh_token: firstRefreshToken5 })
      .expect(204);
    await request(app.getHttpServer())
      .get('/private')
      .auth(next.access_token, { type: 'bearer' })
      .expect(200);
    const { [0]: repliesFirst4 } = replies;

    await request(app.getHttpServer())
      .post('/auth/logout')
      .send({ refresh_token: repliesFirst4!.body.refresh_token })
      .expect(204);
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refresh_token: next.refresh_token, request_id: randomUUID() })
      .expect(401);
  }, 15000);
  it('rejects an expired rotation result without revoking the current session', async (): Promise<void> => {
    const first = await signIn();
    const request_id = randomUUID();
    const { refresh_token: firstRefreshToken6 } = first;
    const { body: expectResultBody6 } = await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refresh_token: firstRefreshToken6, request_id })
      .expect(200);
    const next = expectResultBody6;

    const { refresh_token: firstRefreshToken7 } = first;

    await database.query(
      'UPDATE gchat_auth_sessions SET rotation_expires_at=clock_timestamp() WHERE id=$1',
      [sessionId(firstRefreshToken7)],
    );
    const { refresh_token: firstRefreshToken8 } = first;

    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refresh_token: firstRefreshToken8, request_id })
      .expect(401);
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refresh_token: next.refresh_token, request_id: randomUUID() })
      .expect(200);
  });
  it('checks account disablement immediately, including cached refresh responses', async (): Promise<void> => {
    const first = await signIn();
    const request_id = randomUUID();

    const { refresh_token: firstRefreshToken9 } = first;

    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refresh_token: firstRefreshToken9, request_id })
      .expect(200);
    await database.query('UPDATE gchat_users SET disabled_at = now() WHERE id = $1', [userId]);
    const { access_token: firstAccessToken } = first;

    await request(app.getHttpServer())
      .get('/private')
      .auth(firstAccessToken, { type: 'bearer' })
      .expect(401)
      .expect(({ body }): void => expect(body.error.code).toBe('SESSION_INVALID'));
    const { refresh_token: firstRefreshToken10 } = first;

    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refresh_token: firstRefreshToken10, request_id })
      .expect(401);
    const disabled = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ login, password })
      .expect(401);
    const unknown = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ login: 'unknown-user', password })
      .expect(401);

    const { body: disabledBody } = disabled;
    const { body: unknownBody } = unknown;

    expect(disabledBody).toEqual(unknownBody);
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

    for (let i = 0; i < 5; i++) {
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ login, password: 'incorrect password' })
        .expect(401);
    }

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
      const { body: expectResultBody3 } = await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refresh_token: tokens.refresh_token, request_id })
        .expect(200);

      tokens = expectResultBody3;
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
  it.each(['current', 'previous'])(
    'handles expired rotation during logout with the %s token',
    async (which): Promise<void> => {
      const first = await signIn();
      const { refresh_token: firstRefreshToken11 } = first;
      const { body: expectResultBody7 } = await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refresh_token: firstRefreshToken11, request_id: randomUUID() })
        .expect(200);
      const current = expectResultBody7;
      const { refresh_token: firstRefreshToken12 } = first;
      const sid = sessionId(firstRefreshToken12);

      await database.query(
        'UPDATE gchat_auth_sessions SET rotation_expires_at=clock_timestamp() WHERE id=$1',
        [sid],
      );
      const { refresh_token: firstRefreshToken13 } = first;

      await request(app.getHttpServer())
        .post('/auth/logout')
        .send({ refresh_token: which === 'current' ? current.refresh_token : firstRefreshToken13 })
        .expect(204);
      const { rowCount: queryResultRowCount } = await database.query(
        'SELECT id FROM gchat_auth_sessions WHERE id=$1',
        [sid],
      );

      expect(queryResultRowCount).toBe(which === 'previous' ? 1 : 0);
    },
  );
  it('keeps Auth and WS tickets usable without Redis', async (): Promise<void> => {
    const tokens = await signIn();
    const client = app.get(RedisService).client;

    client.destroy();

    try {
      const { access_token: tokensAccessToken5 } = tokens;

      await request(app.getHttpServer())
        .get('/private')
        .auth(tokensAccessToken5, { type: 'bearer' })
        .expect(200);
      const { access_token: tokensAccessToken6 } = tokens;
      const { body: issuedBody } = await request(app.getHttpServer())
        .post('/auth/ws-ticket')
        .auth(tokensAccessToken6, { type: 'bearer' })
        .set('Origin', 'http://localhost:5173')
        .send({})
        .expect(200);

      await expect(
        app.get(AuthWsTickets).redeem(issuedBody.ticket, 'http://localhost:5173'),
      ).resolves.toMatchObject({ userId });
      const { refresh_token: tokensRefreshToken3 } = tokens;

      await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refresh_token: tokensRefreshToken3, request_id: randomUUID() })
        .expect(200);
      const { refresh_token: tokensRefreshToken4 } = tokens;

      await request(app.getHttpServer())
        .post('/auth/logout')
        .send({ refresh_token: tokensRefreshToken4 })
        .expect(204);
    } finally {
      await client.connect();
    }
  });
  it('allows only one of two different refresh operations with the same token', async (): Promise<void> => {
    const tokens = await signIn();
    const responses = await Promise.all(
      [randomUUID(), randomUUID()].map((request_id): PromiseLike<request.Response> => {
        const { refresh_token: tokensRefreshToken5 } = tokens;

        return request(app.getHttpServer())
          .post('/auth/refresh')
          .send({ refresh_token: tokensRefreshToken5, request_id });
      }),
    );

    const { map: responsesMap } = responses;

    expect(
      responsesMap
        .bind(responses)((response): number => response.status)
        .sort(),
    ).toEqual([200, 401]);
    const { find: responsesFind } = responses;
    const winner = responsesFind.bind(responses)((response): boolean => response.status === 200)!;

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
    const { refresh_token: tokensRefreshToken6 } = tokens;
    const [refresh] = await Promise.all([
      request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refresh_token: tokensRefreshToken6, request_id: randomUUID() }),
      request(app.getHttpServer())
        .post('/auth/logout')
        .send({ refresh_token: tokensRefreshToken6 })
        .expect(204),
    ]);

    expect([200, 401]).toContain(refresh.status);
    const { refresh_token: tokensRefreshToken7 } = tokens;
    const { rowCount: queryResultRowCount2 } = await database.query(
      'SELECT id FROM gchat_auth_sessions WHERE id=$1',
      [sessionId(tokensRefreshToken7)],
    );

    expect(queryResultRowCount2).toBe(0);
    const { access_token: tokensAccessToken7 } = tokens;

    await request(app.getHttpServer())
      .get('/private')
      .auth(tokensAccessToken7, { type: 'bearer' })
      .expect(401);
  });
});
