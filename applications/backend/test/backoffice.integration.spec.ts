import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { jest } from '@jest/globals';
import type { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import pg from 'pg';
import request from 'supertest';

import { AuthCleanup } from '../src/auth/auth.cleanup.js';
import { AuthCrypto, sessionId } from '../src/auth/auth.crypto.js';
import { AuthService } from '../src/auth/auth.service.js';
import { AuthWsTickets } from '../src/auth/auth.ws-tickets.js';
import { BackofficeModule } from '../src/backoffice/backoffice.module.js';
import { BackofficeService } from '../src/backoffice/backoffice.service.js';
import { validateEnvironment } from '../src/config/environment.js';
import type { DatabaseTransaction } from '../src/database/database.service.js';
import { DatabaseService } from '../src/database/database.service.js';
import { runMigrations } from '../src/database/migrations.js';
import { ErrorModule } from '../src/error/error.module.js';
import { GroupsService } from '../src/groups/groups.service.js';
import { LoggerModule } from '../src/logger/logger.module.js';
import { RedisModule } from '../src/redis/redis.module.js';
import { setupSwagger } from '../src/swagger/setup-swagger.js';

const integration =
  process.env.BACKOFFICE_INTEGRATION_DATABASE_URL && process.env.BACKOFFICE_INTEGRATION_REDIS_URL
    ? describe
    : describe.skip;

integration('Backoffice with isolated PostgreSQL', (): void => {
  const name = `gchat_backoffice_${randomUUID().replaceAll('-', '')}`;
  const password = 'correct password with spaces';
  let admin: pg.Pool;
  let pool: pg.Pool;
  let app: INestApplication;
  let hash: string;
  let actor: { id: string; token: string; sid: string };

  async function account(role: 'admin' | 'user' = 'user'): Promise<{
    id: `${string}-${string}-${string}-${string}-${string}`;
    token: string;
    sid: string;
    refresh: string;
    login: string;
  }> {
    const id = randomUUID();
    const login = `test-${id.slice(0, 8)}`;

    await pool.query(
      'INSERT INTO gchat_users(id, login, display_name, password_hash, role) VALUES($1,$2,$3,$4,$5)',
      [id, login, login, hash, role],
    );
    const { access_token: tokensAccessToken, refresh_token: tokensRefreshToken } = await app
      .get(AuthService)
      .login({ login, password });

    return {
      id,
      token: tokensAccessToken,
      sid: sessionId(tokensRefreshToken)!,
      refresh: tokensRefreshToken,
      login,
    };
  }
  const api = (): ReturnType<typeof request> => request(app.getHttpServer());

  beforeAll(async (): Promise<void> => {
    admin = new pg.Pool({ connectionString: process.env.BACKOFFICE_INTEGRATION_DATABASE_URL });
    await admin.query(`CREATE DATABASE "${name}"`);
    const url = new URL(process.env.BACKOFFICE_INTEGRATION_DATABASE_URL!);

    url.pathname = '/' + name;
    await runMigrations(url.href, resolve('drizzle'));
    await runMigrations(url.href, resolve('drizzle'));
    pool = new pg.Pool({ connectionString: url.href, max: 10, statement_timeout: 3000 });
    const settings = validateEnvironment({
      ...process.env,
      DATABASE_URL: url.href,
      REDIS_URL: process.env.BACKOFFICE_INTEGRATION_REDIS_URL,
      REDIS_KEY_PREFIX: `gchat:backoffice-test:${randomUUID()}:`,
    });
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          validate: (): Record<string, unknown> & {
            LOG_REDACTION_ENABLED: boolean;
            PORT: number;
            HOST: string;
          } => settings,
        }),
        LoggerModule.forRoot(),
        ErrorModule,
        RedisModule.forRoot(),
        BackofficeModule,
      ],
    }).compile();

    const { createNestApplication: moduleCreateNestApplication } = module;

    app = moduleCreateNestApplication.bind(module)();
    await app.listen(0, '127.0.0.1');
    hash = await app.get(AuthCrypto).hashPassword(password);
  }, 20000);
  beforeEach(async (): Promise<void> => {
    await pool.query('TRUNCATE gchat_users, gchat_groups CASCADE');
    actor = await account('admin');
  });
  afterAll(async (): Promise<void> => {
    await app?.close();
    await pool?.end();

    try {
      await admin?.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    } finally {
      await admin?.end();
    }
  });

  it('denies unauthorized/ordinary users before looking at target UUIDs and sends no-store errors', async (): Promise<void> => {
    const user = await account();

    await api().get('/admin/users').expect(401).expect('Cache-Control', 'no-store');
    const { token: userToken } = user;

    await api()
      .get('/admin/users/not-a-uuid')
      .auth(userToken, { type: 'bearer' })
      .expect(403)
      .expect('Cache-Control', 'no-store');
    await api().get('/admin/users/not-a-uuid').auth(actor.token, { type: 'bearer' }).expect(400);
    await api()
      .get('/admin/users/' + randomUUID())
      .auth(actor.token, { type: 'bearer' })
      .expect(404);
    // A signed admin claim cannot override the current database role.
    await pool.query("UPDATE gchat_users SET role='user' WHERE id=$1", [actor.id]);
    await api().get('/admin/users').auth(actor.token, { type: 'bearer' }).expect(403);
  });

  it('creates safe user responses, normalizes/reuses groups, rejects duplicate login without side effects', async (): Promise<void> => {
    const input = {
      display_name: ' Андрей ',
      login: ' NEW.USER ',
      password,
      group_name: ' FAMILY ',
    };
    const created = await api()
      .post('/admin/users')
      .auth(actor.token, { type: 'bearer' })
      .send(input)
      .expect(201)
      .expect('Cache-Control', 'no-store');

    const { body: createdBody } = created;

    expect(createdBody.user).toMatchObject({
      login: 'new.user',
      display_name: 'Андрей',
      role: 'user',
      status: 'active',
      disabled_at: null,
      groups: [{ name: 'family' }],
    });
    const { body: createdBody2 } = created;

    expect(Object.keys(createdBody2.user).sort()).toEqual(
      [
        'id',
        'login',
        'display_name',
        'role',
        'status',
        'disabled_at',
        'groups',
        'created_at',
        'updated_at',
      ].sort(),
    );
    const { body: createdBody3 } = created;
    const { rows: queryResultRows4 } = await pool.query(
      'SELECT password_hash FROM gchat_users WHERE id=$1',
      [createdBody3.user.id],
    );
    const stored = queryResultRows4[0];

    expect(await app.get(AuthCrypto).verifyPassword(password, stored.password_hash)).toBe(true);
    await api()
      .post('/admin/users')
      .auth(actor.token, { type: 'bearer' })
      .send({ ...input, group_name: 'must not exist' })
      .expect(409)
      .expect(({ body }): any => expect(body.error.code).toBe('LOGIN_TAKEN'));
    const { rows: queryResultRows } = await pool.query('SELECT name FROM gchat_groups');

    expect(queryResultRows).toEqual([{ name: 'family' }]);
    const generated = await api()
      .post('/admin/users')
      .auth(actor.token, { type: 'bearer' })
      .send({ display_name: 'Generated', password, group_name: 'Family' })
      .expect(201);

    const { body: generatedBody } = generated;

    expect(generatedBody.user.login).toMatch(/^user-[a-z0-9]{8}$/);
    const { body: generatedBody2 } = generated;
    const { body: createdBody4 } = created;

    expect(generatedBody2.user.groups).toEqual(createdBody4.user.groups);
  });

  it('validates fields/query without silently clamping limits or accepting null/role', async (): Promise<void> => {
    for (const query of [
      'limit=0',
      'limit=101',
      'limit=1.2',
      'offset=-1',
      'limit=',
      'status=unknown',
      'extra=1',
      'limit=1&limit=2',
      'q=' + 'x'.repeat(81),
    ]) {
      await api()
        .get('/admin/users?' + query)
        .auth(actor.token, { type: 'bearer' })
        .expect(400);
    }

    for (const query of ['limit=0', 'limit=101', 'offset=-1']) {
      await api()
        .get('/admin/groups?' + query)
        .auth(actor.token, { type: 'bearer' })
        .expect(400);
    }

    for (const extra of [
      { login: null },
      { password: '' },
      { group_name: '  ' },
      { role: 'admin' },
      { display_name: null },
    ]) {
      await api()
        .post('/admin/users')
        .auth(actor.token, { type: 'bearer' })
        .send({ display_name: 'User', password, group_name: 'group', ...extra })
        .expect(400);
    }

    const { rows: queryResultRows2 } = await pool.query(
      'SELECT count(*)::int as n FROM gchat_groups',
    );

    expect(queryResultRows2[0].n).toBe(0);
  });

  it('paginates accounts before membership, searches literal wildcards and reports filtered totals', async (): Promise<void> => {
    const first = await account();
    const second = await account();

    const { id: firstId } = first;

    await pool.query("UPDATE gchat_users SET display_name='Андрей %_' WHERE id=$1", [firstId]);
    const { id: secondId } = second;

    await pool.query("UPDATE gchat_users SET display_name='Борис', disabled_at=now() WHERE id=$1", [
      secondId,
    ]);
    const { rows: queryResultRows3 } = await pool.query(
      "INSERT INTO gchat_groups(name) VALUES('a'),('b') RETURNING id",
    );
    const groups = queryResultRows3;

    for (const group of groups) {
      const { id: firstId2 } = first;

      await pool.query('INSERT INTO gchat_group_members VALUES($1,$2)', [group.id, firstId2]);
    }

    const page = await api()
      .get('/admin/users?q=андр&limit=1')
      .auth(actor.token, { type: 'bearer' })
      .expect(200);

    const { body: pageBody } = page;

    expect(pageBody.total).toBe(1);
    const { body: pageBody2 } = page;

    expect(pageBody2.users[0].groups.map((g: { name: string }): string => g.name)).toEqual([
      'a',
      'b',
    ]);
    const { body: literalBody } = await api()
      .get('/admin/users')
      .query({ q: '%_' })
      .auth(actor.token, { type: 'bearer' })
      .expect(200);

    expect(literalBody.total).toBe(1);
    const disabled = await api()
      .get('/admin/users?status=disabled')
      .auth(actor.token, { type: 'bearer' })
      .expect(200);

    const { body: disabledBody } = disabled;
    const { id: secondId2 } = second;

    expect(disabledBody.users.map((u: { id: string }): string => u.id)).toEqual([secondId2]);
    const { body: emptyBody } = await api()
      .get('/admin/users?offset=100')
      .auth(actor.token, { type: 'bearer' })
      .expect(200);

    expect(emptyBody).toEqual({ users: [], total: 3 });
    const { body: suggestionsBody } = await api()
      .get('/admin/groups?limit=1')
      .auth(actor.token, { type: 'bearer' })
      .expect(200);

    expect(suggestionsBody).toMatchObject({ groups: [{ name: 'a' }], total: 2 });
  });

  it('atomically revokes all sessions on disable/password, preserves disabled state and makes retries safe', async (): Promise<void> => {
    const target = await account();
    const { id: targetId } = target;
    const disabled = await api()
      .post(`/admin/users/${targetId}/disable`)
      .auth(actor.token, { type: 'bearer' })
      .send({})
      .expect(200);

    const { body: disabledBody2 } = disabled;

    expect(disabledBody2.user.status).toBe('disabled');
    const { id: targetId2 } = target;
    const { body: againBody } = await api()
      .post(`/admin/users/${targetId2}/disable`)
      .auth(actor.token, { type: 'bearer' })
      .send({})
      .expect(200);
    const { body: disabledBody3 } = disabled;

    expect(againBody.user.disabled_at).toBe(disabledBody3.user.disabled_at);
    const { token: targetToken } = target;

    await api().get('/groups').auth(targetToken, { type: 'bearer' }).expect(401);
    const { id: targetId3 } = target;
    const { body: changedBody } = await api()
      .post(`/admin/users/${targetId3}/password`)
      .auth(actor.token, { type: 'bearer' })
      .send({ password: 'new valid password value' })
      .expect(200);
    const { body: disabledBody4 } = disabled;

    expect(changedBody.user.disabled_at).toBe(disabledBody4.user.disabled_at);
    const { id: targetId4 } = target;

    await api()
      .post(`/admin/users/${targetId4}/enable`)
      .auth(actor.token, { type: 'bearer' })
      .send({})
      .expect(200);
    const { login: targetLogin } = target;

    await api().post('/auth/login').send({ login: targetLogin, password }).expect(401);
    const { login: targetLogin2 } = target;
    const fresh = await api()
      .post('/auth/login')
      .send({ login: targetLogin2, password: 'new valid password value' })
      .expect(200);

    const { id: targetId5 } = target;

    await api()
      .post(`/admin/users/${targetId5}/enable`)
      .auth(actor.token, { type: 'bearer' })
      .send({})
      .expect(200);
    const { body: freshBody } = fresh;

    await api().get('/groups').auth(freshBody.access_token, { type: 'bearer' }).expect(200);
    await api()
      .post(`/admin/users/${actor.id.toUpperCase()}/disable`)
      .auth(actor.token, { type: 'bearer' })
      .send({})
      .expect(403);
    await api()
      .post(`/admin/users/${actor.id}/password`)
      .auth(actor.token, { type: 'bearer' })
      .send({ password })
      .expect(200);
    await api().get('/admin/users').auth(actor.token, { type: 'bearer' }).expect(401);
  });

  it('serializes reciprocal administrator disable requests and rechecks the losing actor', async (): Promise<void> => {
    const { id: otherId, token: otherToken } = await account('admin');
    const replies = await Promise.all([
      api().post(`/admin/users/${otherId}/disable`).auth(actor.token, { type: 'bearer' }).send({}),
      api().post(`/admin/users/${actor.id}/disable`).auth(otherToken, { type: 'bearer' }).send({}),
    ]);

    const { map: repliesMap } = replies;

    expect(
      repliesMap
        .bind(replies)((reply): number => reply.status)
        .sort(),
    ).toEqual([200, 401]);
    const { rowCount: queryResultRowCount } = await pool.query(
      'SELECT id FROM gchat_users WHERE disabled_at IS NULL',
    );

    expect(queryResultRowCount).toBe(1);
  });

  it('rolls back account creation when group assignment fails', async (): Promise<void> => {
    await pool.query(
      "CREATE FUNCTION reject_membership() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test-only failure'; END $$",
    );
    await pool.query(
      'CREATE TRIGGER reject_membership BEFORE INSERT ON gchat_group_members FOR EACH ROW EXECUTE FUNCTION reject_membership()',
    );

    try {
      await api()
        .post('/admin/users')
        .auth(actor.token, { type: 'bearer' })
        .send({ display_name: 'Rollback', login: 'rollback', password, group_name: 'rollback' })
        .expect(500);
      const { rowCount: queryResultRowCount2 } = await pool.query(
        "SELECT id FROM gchat_users WHERE login='rollback'",
      );

      expect(queryResultRowCount2).toBe(0);
      const { rowCount: queryResultRowCount3 } = await pool.query('SELECT id FROM gchat_groups');

      expect(queryResultRowCount3).toBe(0);
    } finally {
      await pool.query('DROP TRIGGER reject_membership ON gchat_group_members');
      await pool.query('DROP FUNCTION reject_membership()');
    }
  });

  it('prevents a login verified against the old password from persisting after password reset', async (): Promise<void> => {
    const target = await account();
    const crypto = app.get(AuthCrypto);
    const verify = crypto.verifyPassword.bind(crypto);
    let verified!: () => void;
    let resume!: () => void;
    const ready = new Promise<void>((resolve): void => {
      verified = resolve;
    });
    const gate = new Promise<void>((resolve): void => {
      resume = resolve;
    });
    const spy = jest
      .spyOn(crypto, 'verifyPassword')
      .mockImplementationOnce(async (value, stored): Promise<boolean> => {
        const result = await verify(value, stored);

        verified();
        await gate;

        return result;
      });
    const { login: targetLogin3 } = target;
    const login = app.get(AuthService).login({ login: targetLogin3, password });
    // Observe rejection immediately to avoid an unhandled rejection during the reset.
    const outcome = (async () => {
      try {
        await login;
      } catch (rejectedCause) {
        const error: unknown = rejectedCause;

        return error;
      }

      return 'unexpected success';
    })();

    try {
      await ready;
      const { id: targetId6 } = target;

      await api()
        .post(`/admin/users/${targetId6}/password`)
        .auth(actor.token, { type: 'bearer' })
        .send({ password: 'replacement password value' })
        .expect(200);
    } finally {
      resume();
      spy.mockRestore();
    }

    expect(await outcome).toMatchObject({ code: 'INVALID_CREDENTIALS' });
    const { id: targetId7 } = target;
    const { rowCount: queryResultRowCount8 } = await pool.query(
      'SELECT id FROM gchat_auth_sessions WHERE user_id=$1',
      [targetId7],
    );

    expect(queryResultRowCount8).toBe(0);
  });

  it('reuses one normalized group under concurrent independent transactions', async (): Promise<void> => {
    const first = await account();
    const second = await account();
    const db = app.get(DatabaseService);
    const groups = app.get(GroupsService);

    await Promise.all([
      db.db.transaction((tx): Promise<void> => {
        const { id: firstId3 } = first;

        return groups.assign(tx, firstId3, ' CONCURRENT ');
      }),
      db.db.transaction((tx): Promise<void> => {
        const { id: secondId3 } = second;

        return groups.assign(tx, secondId3, 'concurrent');
      }),
    ]);
    const { rowCount: queryResultRowCount4 } = await pool.query(
      "SELECT id FROM gchat_groups WHERE name='concurrent'",
    );

    expect(queryResultRowCount4).toBe(1);
    const { rowCount: queryResultRowCount5 } = await pool.query(
      'SELECT user_id FROM gchat_group_members',
    );

    expect(queryResultRowCount5).toBe(2);
  });

  it('cleans expired data in bounded batches, skips locked rows and preserves live state', async (): Promise<void> => {
    const target = await account();
    const { refresh: targetRefresh } = target;
    const tokens = await app
      .get(AuthService)
      .refresh({ refresh_token: targetRefresh, request_id: randomUUID() });
    const other = await account();

    const { refresh: otherRefresh } = other;

    await app.get(AuthService).refresh({ refresh_token: otherRefresh, request_id: randomUUID() });
    const ticketService = app.get(AuthWsTickets);
    const { access_token: tokensAccessToken2 } = tokens;
    const identity = await app.get(AuthService).authenticate(tokensAccessToken2);
    const issued = await ticketService.issue(identity, 'http://localhost:5173');

    const { sid: targetSid } = target;

    await pool.query(
      "UPDATE gchat_auth_sessions SET rotation_expires_at=clock_timestamp()-interval '1 second', ws_ticket_window_started_at=clock_timestamp()-interval '61 seconds' WHERE id=$1",
      [targetSid],
    );
    await pool.query(
      "UPDATE gchat_auth_ws_tickets SET issued_at=clock_timestamp()-interval '31 seconds', expires_at=clock_timestamp()-interval '1 second'",
    );
    const connection = await pool.connect();

    try {
      const { query: connectionQuery } = connection;

      await connectionQuery.bind(connection)('BEGIN');
      const { sid: targetSid2 } = target;
      const { query: connectionQuery3 } = connection;

      await connectionQuery3.bind(connection)(
        'SELECT id FROM gchat_auth_sessions WHERE id=$1 FOR UPDATE',
        [targetSid2],
      );
      await app.get(AuthCleanup).cleanup();
      const { sid: targetSid3 } = target;
      const { rows: queryResultRows5 } = await pool.query(
        'SELECT rotation_request_id FROM gchat_auth_sessions WHERE id=$1',
        [targetSid3],
      );

      expect(queryResultRows5[0].rotation_request_id).not.toBeNull();
    } finally {
      const { query: connectionQuery2 } = connection;

      await connectionQuery2.bind(connection)('ROLLBACK');
      const { release: connectionRelease } = connection;

      connectionRelease.bind(connection)();
    }

    await app.get(AuthCleanup).cleanup();
    const { sid: targetSid4 } = target;
    const { rows: queryResultRows6 } = await pool.query(
      'SELECT * FROM gchat_auth_sessions WHERE id=$1',
      [targetSid4],
    );
    const row = queryResultRows6[0];

    expect(row.rotation_request_id).toBeNull();
    expect(row.ws_ticket_count).toBe(0);
    expect(row.ws_ticket_window_started_at).toBeNull();
    const { sid: otherSid } = other;
    const { rows: queryResultRows7 } = await pool.query(
      'SELECT rotation_request_id FROM gchat_auth_sessions WHERE id=$1',
      [otherSid],
    );

    expect(queryResultRows7[0].rotation_request_id).not.toBeNull();
    const { ticket: issuedTicket } = issued;

    await expect(ticketService.redeem(issuedTicket, 'http://localhost:5173')).rejects.toMatchObject(
      { code: 'ACCESS_TOKEN_INVALID' },
    );
    const { access_token: tokensAccessToken3 } = tokens;
    const { id: targetId8 } = target;

    await expect(app.get(AuthService).authenticate(tokensAccessToken3)).resolves.toMatchObject({
      userId: targetId8,
    });
  });

  it('enforces session and ticket CHECK constraints and cascades revocation', async (): Promise<void> => {
    const target = await account();

    const { sid: targetSid5 } = target;

    await expect(
      pool.query('UPDATE gchat_auth_sessions SET rotation_request_id=$1 WHERE id=$2', [
        randomUUID(),
        targetSid5,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
    const { sid: targetSid6 } = target;

    await expect(
      pool.query('UPDATE gchat_auth_sessions SET ws_ticket_count=-1 WHERE id=$1', [targetSid6]),
    ).rejects.toMatchObject({ code: '23514' });
    const { token: targetToken2 } = target;
    const identity = await app.get(AuthService).authenticate(targetToken2);
    const ticket = await app.get(AuthWsTickets).issue(identity, 'http://localhost:5173');

    const { id: targetId9 } = target;

    await api()
      .post(`/admin/users/${targetId9}/disable`)
      .auth(actor.token, { type: 'bearer' })
      .send({})
      .expect(200);
    const { rowCount: queryResultRowCount6 } = await pool.query(
      'SELECT ticket_hash FROM gchat_auth_ws_tickets',
    );

    expect(queryResultRowCount6).toBe(0);
    const { ticket: ticketTicket } = ticket;

    await expect(
      app.get(AuthWsTickets).redeem(ticketTicket, 'http://localhost:5173'),
    ).rejects.toMatchObject({ code: 'ACCESS_TOKEN_INVALID' });
  });

  it('reports an unknown COMMIT result without replaying a committed creation', async (): Promise<void> => {
    const identity = await app.get(AuthService).authenticate(actor.token);
    const db = app.get(DatabaseService).db;
    const original = db.transaction.bind(db);
    const spy = jest
      .spyOn(db, 'transaction')
      .mockImplementationOnce(
        async <T>(
          fn: (tx: DatabaseTransaction) => Promise<T>,
          config?: Parameters<typeof db.transaction>[1],
        ): Promise<T> => {
          await original(fn, config);

          throw new Error('Connection terminated unexpectedly');
        },
      );

    try {
      await expect(
        app.get(BackofficeService).create(identity, {
          display_name: 'Unknown commit',
          login: 'unknown-commit',
          password,
          group_name: 'unknown commit',
        }),
      ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }

    const { rowCount: queryResultRowCount7 } = await pool.query(
      "SELECT id FROM gchat_users WHERE login='unknown-commit'",
    );

    expect(queryResultRowCount7).toBe(1);
  });

  it('rolls back session revocation together with a failed access change', async (): Promise<void> => {
    const target = await account();

    await pool.query(
      "CREATE FUNCTION reject_account_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test-only failure'; END $$",
    );
    await pool.query(
      'CREATE TRIGGER reject_account_update BEFORE UPDATE ON gchat_users FOR EACH ROW EXECUTE FUNCTION reject_account_update()',
    );

    try {
      const { id: targetId10 } = target;

      await api()
        .post(`/admin/users/${targetId10}/disable`)
        .auth(actor.token, { type: 'bearer' })
        .send({})
        .expect(500);
      const { token: targetToken3 } = target;

      await api().get('/groups').auth(targetToken3, { type: 'bearer' }).expect(200);
      const { id: targetId11 } = target;
      const { rows: queryResultRows8 } = await pool.query(
        'SELECT disabled_at FROM gchat_users WHERE id=$1',
        [targetId11],
      );

      expect(queryResultRows8[0].disabled_at).toBeNull();
    } finally {
      await pool.query('DROP TRIGGER reject_account_update ON gchat_users');
      await pool.query('DROP FUNCTION reject_account_update()');
    }
  });

  it('publishes every administrative route and safe response DTO in OpenAPI', (): void => {
    const document = setupSwagger(app);

    for (const path of [
      '/admin/users',
      '/admin/users/{user_id}',
      '/admin/groups',
      '/admin/users/{user_id}/password',
      '/admin/users/{user_id}/disable',
      '/admin/users/{user_id}/enable',
    ]) {
      expect(document.paths[path]).toBeDefined();
    }
  });
});
