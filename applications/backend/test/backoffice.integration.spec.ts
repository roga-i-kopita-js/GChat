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
    const tokens = await app.get(AuthService).login({ login, password });

    return {
      id,
      token: tokens.access_token,
      sid: sessionId(tokens.refresh_token)!,
      refresh: tokens.refresh_token,
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

    app = module.createNestApplication();
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
    await api()
      .get('/admin/users/not-a-uuid')
      .auth(user.token, { type: 'bearer' })
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

    expect(created.body.user).toMatchObject({
      login: 'new.user',
      display_name: 'Андрей',
      role: 'user',
      status: 'active',
      disabled_at: null,
      groups: [{ name: 'family' }],
    });
    expect(Object.keys(created.body.user).sort()).toEqual(
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
    const stored = (
      await pool.query('SELECT password_hash FROM gchat_users WHERE id=$1', [created.body.user.id])
    ).rows[0];

    expect(await app.get(AuthCrypto).verifyPassword(password, stored.password_hash)).toBe(true);
    await api()
      .post('/admin/users')
      .auth(actor.token, { type: 'bearer' })
      .send({ ...input, group_name: 'must not exist' })
      .expect(409)
      .expect(({ body }): any => expect(body.error.code).toBe('LOGIN_TAKEN'));
    expect((await pool.query('SELECT name FROM gchat_groups')).rows).toEqual([{ name: 'family' }]);
    const generated = await api()
      .post('/admin/users')
      .auth(actor.token, { type: 'bearer' })
      .send({ display_name: 'Generated', password, group_name: 'Family' })
      .expect(201);

    expect(generated.body.user.login).toMatch(/^user-[a-z0-9]{8}$/);
    expect(generated.body.user.groups).toEqual(created.body.user.groups);
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

    expect((await pool.query('SELECT count(*)::int as n FROM gchat_groups')).rows[0].n).toBe(0);
  });

  it('paginates accounts before membership, searches literal wildcards and reports filtered totals', async (): Promise<void> => {
    const first = await account();
    const second = await account();

    await pool.query("UPDATE gchat_users SET display_name='Андрей %_' WHERE id=$1", [first.id]);
    await pool.query("UPDATE gchat_users SET display_name='Борис', disabled_at=now() WHERE id=$1", [
      second.id,
    ]);
    const groups = (
      await pool.query("INSERT INTO gchat_groups(name) VALUES('a'),('b') RETURNING id")
    ).rows;

    for (const group of groups) {
      await pool.query('INSERT INTO gchat_group_members VALUES($1,$2)', [group.id, first.id]);
    }

    const page = await api()
      .get('/admin/users?q=андр&limit=1')
      .auth(actor.token, { type: 'bearer' })
      .expect(200);

    expect(page.body.total).toBe(1);
    expect(page.body.users[0].groups.map((g: { name: string }): string => g.name)).toEqual([
      'a',
      'b',
    ]);
    const literal = await api()
      .get('/admin/users')
      .query({ q: '%_' })
      .auth(actor.token, { type: 'bearer' })
      .expect(200);

    expect(literal.body.total).toBe(1);
    const disabled = await api()
      .get('/admin/users?status=disabled')
      .auth(actor.token, { type: 'bearer' })
      .expect(200);

    expect(disabled.body.users.map((u: { id: string }): string => u.id)).toEqual([second.id]);
    const empty = await api()
      .get('/admin/users?offset=100')
      .auth(actor.token, { type: 'bearer' })
      .expect(200);

    expect(empty.body).toEqual({ users: [], total: 3 });
    const suggestions = await api()
      .get('/admin/groups?limit=1')
      .auth(actor.token, { type: 'bearer' })
      .expect(200);

    expect(suggestions.body).toMatchObject({ groups: [{ name: 'a' }], total: 2 });
  });

  it('atomically revokes all sessions on disable/password, preserves disabled state and makes retries safe', async (): Promise<void> => {
    const target = await account();
    const disabled = await api()
      .post(`/admin/users/${target.id}/disable`)
      .auth(actor.token, { type: 'bearer' })
      .send({})
      .expect(200);

    expect(disabled.body.user.status).toBe('disabled');
    const again = await api()
      .post(`/admin/users/${target.id}/disable`)
      .auth(actor.token, { type: 'bearer' })
      .send({})
      .expect(200);

    expect(again.body.user.disabled_at).toBe(disabled.body.user.disabled_at);
    await api().get('/groups').auth(target.token, { type: 'bearer' }).expect(401);
    const changed = await api()
      .post(`/admin/users/${target.id}/password`)
      .auth(actor.token, { type: 'bearer' })
      .send({ password: 'new valid password value' })
      .expect(200);

    expect(changed.body.user.disabled_at).toBe(disabled.body.user.disabled_at);
    await api()
      .post(`/admin/users/${target.id}/enable`)
      .auth(actor.token, { type: 'bearer' })
      .send({})
      .expect(200);
    await api().post('/auth/login').send({ login: target.login, password }).expect(401);
    const fresh = await api()
      .post('/auth/login')
      .send({ login: target.login, password: 'new valid password value' })
      .expect(200);

    await api()
      .post(`/admin/users/${target.id}/enable`)
      .auth(actor.token, { type: 'bearer' })
      .send({})
      .expect(200);
    await api().get('/groups').auth(fresh.body.access_token, { type: 'bearer' }).expect(200);
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
    const other = await account('admin');
    const replies = await Promise.all([
      api().post(`/admin/users/${other.id}/disable`).auth(actor.token, { type: 'bearer' }).send({}),
      api().post(`/admin/users/${actor.id}/disable`).auth(other.token, { type: 'bearer' }).send({}),
    ]);

    expect(replies.map((reply): number => reply.status).sort()).toEqual([200, 401]);
    expect(
      (await pool.query('SELECT id FROM gchat_users WHERE disabled_at IS NULL')).rowCount,
    ).toBe(1);
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
      expect((await pool.query("SELECT id FROM gchat_users WHERE login='rollback'")).rowCount).toBe(
        0,
      );
      expect((await pool.query('SELECT id FROM gchat_groups')).rowCount).toBe(0);
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
    const login = app.get(AuthService).login({ login: target.login, password });
    // Observe rejection immediately to avoid an unhandled rejection during the reset.
    const outcome = login.then(
      (): string => 'unexpected success',
      (error: unknown): unknown => error,
    );

    try {
      await ready;
      await api()
        .post(`/admin/users/${target.id}/password`)
        .auth(actor.token, { type: 'bearer' })
        .send({ password: 'replacement password value' })
        .expect(200);
    } finally {
      resume();
      spy.mockRestore();
    }

    expect(await outcome).toMatchObject({ code: 'INVALID_CREDENTIALS' });
    expect(
      (await pool.query('SELECT id FROM gchat_auth_sessions WHERE user_id=$1', [target.id]))
        .rowCount,
    ).toBe(0);
  });

  it('reuses one normalized group under concurrent independent transactions', async (): Promise<void> => {
    const first = await account();
    const second = await account();
    const db = app.get(DatabaseService);
    const groups = app.get(GroupsService);

    await Promise.all([
      db.db.transaction((tx): Promise<void> => groups.assign(tx, first.id, ' CONCURRENT ')),
      db.db.transaction((tx): Promise<void> => groups.assign(tx, second.id, 'concurrent')),
    ]);
    expect((await pool.query("SELECT id FROM gchat_groups WHERE name='concurrent'")).rowCount).toBe(
      1,
    );
    expect((await pool.query('SELECT user_id FROM gchat_group_members')).rowCount).toBe(2);
  });

  it('cleans expired data in bounded batches, skips locked rows and preserves live state', async (): Promise<void> => {
    const target = await account();
    const tokens = await app
      .get(AuthService)
      .refresh({ refresh_token: target.refresh, request_id: randomUUID() });
    const other = await account();

    await app.get(AuthService).refresh({ refresh_token: other.refresh, request_id: randomUUID() });
    const ticketService = app.get(AuthWsTickets);
    const identity = await app.get(AuthService).authenticate(tokens.access_token);
    const issued = await ticketService.issue(identity, 'http://localhost:5173');

    await pool.query(
      "UPDATE gchat_auth_sessions SET rotation_expires_at=clock_timestamp()-interval '1 second', ws_ticket_window_started_at=clock_timestamp()-interval '61 seconds' WHERE id=$1",
      [target.sid],
    );
    await pool.query(
      "UPDATE gchat_auth_ws_tickets SET issued_at=clock_timestamp()-interval '31 seconds', expires_at=clock_timestamp()-interval '1 second'",
    );
    const connection = await pool.connect();

    try {
      await connection.query('BEGIN');
      await connection.query('SELECT id FROM gchat_auth_sessions WHERE id=$1 FOR UPDATE', [
        target.sid,
      ]);
      await app.get(AuthCleanup).cleanup();
      expect(
        (
          await pool.query('SELECT rotation_request_id FROM gchat_auth_sessions WHERE id=$1', [
            target.sid,
          ])
        ).rows[0].rotation_request_id,
      ).not.toBeNull();
    } finally {
      await connection.query('ROLLBACK');
      connection.release();
    }

    await app.get(AuthCleanup).cleanup();
    const row = (await pool.query('SELECT * FROM gchat_auth_sessions WHERE id=$1', [target.sid]))
      .rows[0];

    expect(row.rotation_request_id).toBeNull();
    expect(row.ws_ticket_count).toBe(0);
    expect(row.ws_ticket_window_started_at).toBeNull();
    expect(
      (
        await pool.query('SELECT rotation_request_id FROM gchat_auth_sessions WHERE id=$1', [
          other.sid,
        ])
      ).rows[0].rotation_request_id,
    ).not.toBeNull();
    await expect(
      ticketService.redeem(issued.ticket, 'http://localhost:5173'),
    ).rejects.toMatchObject({ code: 'ACCESS_TOKEN_INVALID' });
    await expect(app.get(AuthService).authenticate(tokens.access_token)).resolves.toMatchObject({
      userId: target.id,
    });
  });

  it('enforces session and ticket CHECK constraints and cascades revocation', async (): Promise<void> => {
    const target = await account();

    await expect(
      pool.query('UPDATE gchat_auth_sessions SET rotation_request_id=$1 WHERE id=$2', [
        randomUUID(),
        target.sid,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      pool.query('UPDATE gchat_auth_sessions SET ws_ticket_count=-1 WHERE id=$1', [target.sid]),
    ).rejects.toMatchObject({ code: '23514' });
    const identity = await app.get(AuthService).authenticate(target.token);
    const ticket = await app.get(AuthWsTickets).issue(identity, 'http://localhost:5173');

    await api()
      .post(`/admin/users/${target.id}/disable`)
      .auth(actor.token, { type: 'bearer' })
      .send({})
      .expect(200);
    expect((await pool.query('SELECT ticket_hash FROM gchat_auth_ws_tickets')).rowCount).toBe(0);
    await expect(
      app.get(AuthWsTickets).redeem(ticket.ticket, 'http://localhost:5173'),
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

    expect(
      (await pool.query("SELECT id FROM gchat_users WHERE login='unknown-commit'")).rowCount,
    ).toBe(1);
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
      await api()
        .post(`/admin/users/${target.id}/disable`)
        .auth(actor.token, { type: 'bearer' })
        .send({})
        .expect(500);
      await api().get('/groups').auth(target.token, { type: 'bearer' }).expect(200);
      expect(
        (await pool.query('SELECT disabled_at FROM gchat_users WHERE id=$1', [target.id])).rows[0]
          .disabled_at,
      ).toBeNull();
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
