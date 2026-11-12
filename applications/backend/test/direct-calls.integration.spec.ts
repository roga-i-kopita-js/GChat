import { createHmac, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import pg from 'pg';
import { createClient } from 'redis';
import request from 'supertest';

import { AuthCrypto } from '../src/auth/auth.crypto.js';
import { AuthGuard } from '../src/auth/auth.guard.js';
import { AuthLimits } from '../src/auth/auth.limits.js';
import { AuthRepository } from '../src/auth/auth.repository.js';
import { AuthService } from '../src/auth/auth.service.js';
import { AuthSessions } from '../src/auth/auth.sessions.js';
import { validateEnvironment } from '../src/config/environment.js';
import { DatabaseService } from '../src/database/database.service.js';
import { runMigrations } from '../src/database/migrations.js';
import { DevicesService } from '../src/devices/devices.service.js';
import { CallHistoryController } from '../src/direct-calls/call-history.controller.js';
import { CallHistoryLimits } from '../src/direct-calls/call-history.limits.js';
import { CallHistoryService } from '../src/direct-calls/call-history.service.js';
import { DirectCallsDeliveryStore } from '../src/direct-calls/direct-calls.delivery-store.js';
import type { CallActor } from '../src/direct-calls/direct-calls.dto.js';
import { DirectCallsPresence } from '../src/direct-calls/direct-calls.presence.js';
import { DirectCallsRepository } from '../src/direct-calls/direct-calls.repository.js';
import { DirectCallsService } from '../src/direct-calls/direct-calls.service.js';
import { ErrorModule } from '../src/error/error.module.js';
import { ErrorService } from '../src/error/error.service.js';
import { GroupsRepository } from '../src/groups/groups.repository.js';
import { GroupsService } from '../src/groups/groups.service.js';
import { LoggerModule } from '../src/logger/logger.module.js';
import { LoggerService } from '../src/logger/logger.service.js';
import { RedisService } from '../src/redis/redis.service.js';

const integration =
  process.env.CALLS_INTEGRATION_DATABASE_URL && process.env.CALLS_INTEGRATION_REDIS_URL
    ? describe
    : describe.skip;

integration('DirectCalls transactions with isolated PostgreSQL and Redis', (): void => {
  const name = 'gchat_calls_' + randomUUID().replaceAll('-', '');
  const prefix = `gchat:calls-test:${randomUUID()}:`;
  let admin: pg.Pool;
  let pool: pg.Pool;
  let redis: ReturnType<typeof createClient>;
  let db: DatabaseService;
  let auth: AuthService;
  let groups: GroupsService;
  let devices: DevicesService;
  let calls: DirectCallsService;
  let store: DirectCallsDeliveryStore;
  let presence: DirectCallsPresence;
  let config: ConfigService;
  let actors: CallActor[];
  let groupId: string;
  let app: NestExpressApplication;
  let historyLimits: CallHistoryLimits;
  const error = new ErrorService();

  beforeAll(async (): Promise<void> => {
    admin = new pg.Pool({
      connectionString: process.env.CALLS_INTEGRATION_DATABASE_URL,
      connectionTimeoutMillis: 2000,
    });
    await admin.query(`CREATE DATABASE "${name}"`);
    const url = new URL(process.env.CALLS_INTEGRATION_DATABASE_URL!);

    url.pathname = '/' + name;
    await runMigrations(url.href, resolve('drizzle'));
    await runMigrations(url.href, resolve('drizzle'));
    pool = new pg.Pool({ connectionString: url.href, max: 10, statement_timeout: 3000 });
    db = new DatabaseService(pool);
    redis = createClient({ url: process.env.CALLS_INTEGRATION_REDIS_URL });
    redis.on('error', (): void => {});
    await redis.connect();
    config = new ConfigService(
      validateEnvironment({
        ...process.env,
        DATABASE_URL: url.href,
        REDIS_URL: process.env.CALLS_INTEGRATION_REDIS_URL,
        REDIS_KEY_PREFIX: prefix,
      }),
    );
    const sessions = new AuthSessions(db, error);

    auth = new AuthService(
      new AuthRepository(db, error),
      new AuthCrypto(config, error),
      sessions,
      new AuthLimits(error, config),
      error,
    );
    groups = new GroupsService(new GroupsRepository(db, error));
    devices = new DevicesService(db, auth, error, config);
    presence = new DirectCallsPresence(new RedisService(redis, config), error);
    calls = new DirectCallsService(
      new DirectCallsRepository(db, error),
      auth,
      groups,
      devices,
      presence,
      config,
      error,
      new LoggerService(),
    );
    store = new DirectCallsDeliveryStore(db);
    historyLimits = new CallHistoryLimits(new RedisService(redis, config), error);
    const history = new CallHistoryService(
      new DirectCallsRepository(db, error),
      auth,
      devices,
      historyLimits,
      error,
    );
    const module = await Test.createTestingModule({
      imports: [LoggerModule.forRoot(), ErrorModule],
      controllers: [CallHistoryController],
      providers: [
        AuthGuard,
        { provide: AuthService, useValue: auth },
        { provide: CallHistoryService, useValue: history },
      ],
    }).compile();
    const { createNestApplication: moduleResult1 } = module;

    app = moduleResult1.bind(module)<NestExpressApplication>({ logger: false });
    await app.init();
  }, 20000);

  beforeEach(async (): Promise<void> => {
    await pool.query(
      'TRUNCATE gchat_direct_calls, gchat_devices, gchat_users, gchat_groups CASCADE',
    );
    actors = [];

    for (let i = 0; i < 3; i++) {
      const userId = randomUUID();
      const sessionId = randomUUID();

      await pool.query(
        'INSERT INTO gchat_users(id,login,display_name,password_hash) VALUES($1,$2,$2,$3)',
        [userId, 'user-' + i, 'unused'],
      );
      await pool.query(
        'INSERT INTO gchat_auth_sessions(id,user_id,refresh_token_hash) VALUES($1,$2,$3)',
        [sessionId, userId, 'unused'],
      );
      const deviceIdValue = await devices.bind(userId, sessionId, null);

      actors.push({ userId, sessionId, deviceId: deviceIdValue });
    }

    const { rows: queryResultRows } = await pool.query(
      'INSERT INTO gchat_groups(name) VALUES($1) RETURNING id',
      ['test'],
    );

    groupId = queryResultRows[0].id;

    for (const actor of actors) {
      await pool.query('INSERT INTO gchat_group_members VALUES($1,$2)', [groupId, actor.userId]);
    }
  });

  afterAll(async (): Promise<void> => {
    await app?.close();

    if (redis?.isOpen) {
      for await (const keys of redis.scanIterator({ MATCH: prefix + '*' })) {
        if (keys.length) {
          await redis.del(keys);
        }
      }

      await redis.close();
    }

    await pool?.end();

    try {
      await admin?.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    } finally {
      await admin?.end();
    }
  });

  async function token(index: number): Promise<string> {
    const account = await new AuthRepository(db, error).byId(actors[index].userId);
    const result = await new AuthCrypto(config, error).issue(account!, actors[index].sessionId);
    const { access_token: resultResult2 } = result;

    return resultResult2;
  }

  async function historySeed(
    overrides: {
      id?: string;
      created?: string;
      started?: string | null;
      ended?: string;
      reason?: string;
      reverse?: boolean;
    } = {},
  ): Promise<string> {
    const id = overrides.id ?? randomUUID();

    await pool.query(
      `INSERT INTO gchat_direct_call_history(call_id,caller_id,recipient_id,created_at,started_at,ended_at,end_reason,version)
      VALUES($1,$2,$3,$4,$5,$6,$7,1)`,
      [
        id,
        actors[overrides.reverse ? 1 : 0].userId,
        actors[overrides.reverse ? 0 : 1].userId,
        overrides.created ?? '2020-01-01T12:00:00.000000Z',
        overrides.started ?? null,
        overrides.ended ?? '2020-01-01T12:05:00Z',
        overrides.reason ?? 'no_answer',
      ],
    );

    return id;
  }

  describe('durable history API', (): void => {
    it('archives final state once before its event and keeps it after technical cleanup', async (): Promise<void> => {
      const call = await calls.create(actors[0], actors[1].userId);
      const { call_id: callResult3 } = call;

      const ended = await calls.cancel(actors[0], callResult3);
      const { version: endedResult5 } = ended;

      await calls.cancel(actors[0], callResult3);
      const before = await request(app.getHttpServer())
        .get('/calls/history/' + callResult3)
        .auth(await token(1), { type: 'bearer' })
        .expect(200);
      const { body: beforeResult4 } = before;

      expect(beforeResult4.item).toMatchObject({
        call_id: callResult3,
        version: endedResult5,
        outcome: 'missed',
        direction: 'incoming',
        duration_seconds: null,
        started_at: null,
      });
      const { rows } = await pool.query(
        'SELECT snapshot FROM gchat_direct_call_deliveries WHERE call_id=$1 AND version=$2',
        [callResult3, endedResult5],
      );

      expect(rows[0].snapshot.state).toBe('ended');
      await pool.query(
        "UPDATE gchat_direct_calls SET created_at=now()-interval '40 days', ended_at=now()-interval '31 days' WHERE id=$1",
        [callResult3],
      );
      await calls.cleanup();
      await expect(calls.get(actors[1], callResult3)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      const after = await request(app.getHttpServer())
        .get('/calls/history/' + callResult3)
        .auth(await token(1), { type: 'bearer' })
        .expect(200);
      const { body: afterResult6 } = after;

      expect(afterResult6).toEqual(beforeResult4);
      const count = await pool.query(
        'SELECT count(*)::int AS count FROM gchat_direct_call_history WHERE call_id=$1',
        [callResult3],
      );
      const { rows: countResult7 } = count;

      expect(countResult7[0].count).toBe(1);
    });

    it('rolls back terminal state, busy release and outbox if archival conflicts', async (): Promise<void> => {
      const call = await calls.create(actors[0], actors[1].userId);
      const { call_id: callResult8 } = call;

      await historySeed({ id: callResult8, reason: 'rejected' });
      await expect(calls.cancel(actors[0], callResult8)).rejects.toMatchObject({
        code: 'INTERNAL_ERROR',
      });
      expect(await calls.get(actors[0], callResult8)).toMatchObject({
        state: 'ringing',
        version: 0,
      });
      const { rows } = await pool.query(
        'SELECT released_at FROM gchat_direct_call_participants WHERE call_id=$1',
        [callResult8],
      );

      expect(rows).toEqual([{ released_at: null }, { released_at: null }]);
      const { rows: versions } = await pool.query(
        'SELECT version FROM gchat_direct_call_deliveries WHERE call_id=$1',
        [callResult8],
      );

      expect(versions).toEqual([{ version: '0' }]);
    });

    it('returns current names and metadata outside groups, while protecting participation and actor binding', async (): Promise<void> => {
      const id = await historySeed();
      const { toUpperCase: idResult9 } = id;

      await pool.query('DELETE FROM gchat_group_members WHERE user_id=$1', [actors[1].userId]);
      await pool.query(
        "UPDATE gchat_users SET display_name='Renamed', disabled_at=now() WHERE id=$1",
        [actors[1].userId],
      );
      const access = await token(0);
      const response = await request(app.getHttpServer())
        .get('/calls/history/' + idResult9.bind(id)())
        .auth(access, { type: 'bearer' })
        .expect(200);
      const { headers: responseResult10, body: responseResult11 } = response;

      expect(responseResult10['cache-control']).toBe('no-store');
      expect(responseResult11.item).toMatchObject({
        peer_display_name: 'Renamed',
        direction: 'outgoing',
        outcome: 'unanswered',
      });
      await pool.query("UPDATE gchat_users SET role='admin' WHERE id=$1", [actors[2].userId]);
      const foreign = await request(app.getHttpServer())
        .get('/calls/history/' + id)
        .auth(await token(2), { type: 'bearer' })
        .expect(404);
      const { body: foreignResult12, headers: foreignResult14 } = foreign;

      const missing = await request(app.getHttpServer())
        .get('/calls/history/' + randomUUID())
        .auth(await token(2), { type: 'bearer' })
        .expect(404);
      const { body: missingResult13 } = missing;

      expect(foreignResult12).toEqual(missingResult13);
      expect(foreignResult14['cache-control']).toBe('no-store');
      await pool.query('DELETE FROM gchat_device_sessions WHERE session_id=$1', [
        actors[0].sessionId,
      ]);
      await request(app.getHttpServer())
        .get('/calls/history')
        .auth(access, { type: 'bearer' })
        .expect(403);
    });

    it('paginates exact microseconds and equal timestamps without duplicates or omissions', async (): Promise<void> => {
      const ids: string[] = [];

      for (const created of [
        '2020-01-01T12:00:00.123457Z',
        '2020-01-01T12:00:00.123456Z',
        '2020-01-01T12:00:00.123456Z',
        '2020-01-01T12:00:00.123455Z',
      ]) {
        ids.push(await historySeed({ created }));
      }

      const access = await token(0);
      const first = await request(app.getHttpServer())
        .get('/calls/history?limit=1')
        .auth(access, { type: 'bearer' })
        .expect(200);
      const { body: firstResult15 } = first;

      const second = await request(app.getHttpServer())
        .get('/calls/history')
        .query({ limit: 2, cursor: firstResult15.next_cursor })
        .auth(access, { type: 'bearer' })
        .expect(200);
      const { body: secondResult16 } = second;

      const third = await request(app.getHttpServer())
        .get('/calls/history')
        .query({ limit: 100, cursor: secondResult16.next_cursor })
        .auth(access, { type: 'bearer' })
        .expect(200);
      const { body: thirdResult17 } = third;

      const expected = await pool.query(
        'SELECT call_id FROM gchat_direct_call_history ORDER BY created_at DESC, call_id DESC',
      );
      const { rows: expectedResult18 } = expected;

      expect(
        [...firstResult15.items, ...secondResult16.items, ...thirdResult17.items].map(
          (r: { call_id: string }): string => r.call_id,
        ),
      ).toEqual(expectedResult18.map((r): string => r.call_id));
      expect(thirdResult17.next_cursor).toBeNull();
      expect(new Set(expectedResult18.map((r): string => r.call_id)).size).toBe(ids.length);
      await request(app.getHttpServer())
        .get('/calls/history')
        .query({ filter: 'missed', cursor: firstResult15.next_cursor })
        .auth(access, { type: 'bearer' })
        .expect(400);
      await request(app.getHttpServer())
        .get('/calls/history')
        .query({ cursor: firstResult15.next_cursor })
        .auth(await token(1), { type: 'bearer' })
        .expect(400);
    });

    it('filters missed calls at account level and reports actual conversation duration', async (): Promise<void> => {
      const missed = await historySeed();
      const cancelled = await historySeed({ reason: 'cancelled' });

      await historySeed({ reason: 'rejected' });
      await historySeed({ reason: 'connection_timeout' });
      await historySeed({ reverse: true });
      const connected = await historySeed({
        reason: 'connection_lost',
        started: '2020-01-01T12:01:00.500Z',
      });
      const incoming = await request(app.getHttpServer())
        .get('/calls/history?filter=missed')
        .auth(await token(1), { type: 'bearer' })
        .expect(200);
      const { body: incomingResult19 } = incoming;

      expect(
        incomingResult19.items.map((r: { call_id: string }): string => r.call_id).sort(),
      ).toEqual([missed, cancelled].sort());
      const detail = await request(app.getHttpServer())
        .get('/calls/history/' + connected)
        .auth(await token(0), { type: 'bearer' })
        .expect(200);
      const { body: detailResult20 } = detail;

      expect(detailResult20.item).toMatchObject({ outcome: 'completed', duration_seconds: 239 });
      const { userId, sessionId } = actors[1];
      const another = randomUUID();

      await pool.query(
        'INSERT INTO gchat_auth_sessions(id,user_id,refresh_token_hash) VALUES($1,$2,$3)',
        [another, userId, 'unused'],
      );
      const account = await new AuthRepository(db, error).byId(userId);
      const jwt = await new AuthCrypto(config, error).issue(account!, another);
      const { access_token: jwtResult21 } = jwt;

      await devices.bind(userId, another, null);
      const otherDevice = await request(app.getHttpServer())
        .get('/calls/history?filter=missed')
        .auth(jwtResult21, { type: 'bearer' })
        .expect(200);
      const { body: otherDeviceResult22 } = otherDevice;

      expect(otherDeviceResult22).toEqual(incomingResult19);
      expect(sessionId).not.toBe(another);
    });

    it('validates query and UUID, requires authentication, and gives no-store errors', async (): Promise<void> => {
      const access = await token(0);
      const unauthorized = await request(app.getHttpServer()).get('/calls/history').expect(401);
      const { headers: unauthorizedResult23 } = unauthorized;

      expect(unauthorizedResult23['cache-control']).toBe('no-store');

      for (const path of [
        '/calls/history?limit=0',
        '/calls/history?limit=101',
        '/calls/history?limit=1.2',
        '/calls/history?limit=1e1',
        '/calls/history?limit=-1',
        '/calls/history?filter=other',
        '/calls/history?filter=all&filter=missed',
        '/calls/history?limit=1&limit=2',
        '/calls/history?user_id=other',
        '/calls/history?cursor=',
        '/calls/history?cursor=bad',
        '/calls/history/not-a-uuid',
      ]) {
        const response = await request(app.getHttpServer())
          .get(path)
          .auth(access, { type: 'bearer' })
          .expect(400);
        const { body: responseResult24, headers: responseResult25 } = response;

        expect(responseResult24.error.code).toBe('VALIDATION_ERROR');
        expect(responseResult25['cache-control']).toBe('no-store');
      }

      const empty = await request(app.getHttpServer())
        .get('/calls/history')
        .auth(access, { type: 'bearer' })
        .expect(200);
      const { body: emptyResult26 } = empty;

      expect(emptyResult26).toEqual({ items: [], next_cursor: null });
    });

    it('shares Redis read limit between list/get, without blocking call control', async (): Promise<void> => {
      const id = await historySeed();
      const access = await token(0);

      await redis.hSet(prefix + 'direct-calls:history:rate:' + actors[0].userId, {
        credit_ms: '0',
        updated_at_ms: String(Date.now() + 10000),
      });

      for (const path of ['/calls/history', '/calls/history/' + id]) {
        const response = await request(app.getHttpServer())
          .get(path)
          .auth(access, { type: 'bearer' })
          .expect(429);
        const { headers: responseResult27 } = response;

        expect(Number(responseResult27['retry-after'])).toBeGreaterThanOrEqual(1);
      }

      const call = await calls.create(actors[0], actors[1].userId);
      const { call_id: callResult28 } = call;

      await expect(calls.cancel(actors[0], callResult28)).resolves.toMatchObject({
        state: 'ended',
      });
    });

    it('keeps unfinished calls out of history and rejects disabled or revoked actors', async (): Promise<void> => {
      const { call_id: ongoing } = await calls.create(actors[0], actors[1].userId);
      const access = await token(0);

      await request(app.getHttpServer())
        .get('/calls/history/' + ongoing)
        .auth(access, { type: 'bearer' })
        .expect(404);
      const { body } = await request(app.getHttpServer())
        .get('/calls/history')
        .auth(access, { type: 'bearer' })
        .expect(200);

      expect(body).toEqual({ items: [], next_cursor: null });
      await calls.cancel(actors[0], ongoing);
      await pool.query('UPDATE gchat_users SET disabled_at=now() WHERE id=$1', [actors[0].userId]);
      const { body: disabled, headers } = await request(app.getHttpServer())
        .get('/calls/history')
        .auth(access, { type: 'bearer' })
        .expect(401);

      expect(disabled.error.code).toBe('SESSION_INVALID');
      expect(headers['cache-control']).toBe('no-store');
      const other = await token(2);

      await pool.query('DELETE FROM gchat_auth_sessions WHERE id=$1', [actors[2].sessionId]);
      const { body: revoked } = await request(app.getHttpServer())
        .get('/calls/history')
        .auth(other, { type: 'bearer' })
        .expect(401);

      expect(revoked.error.code).toBe('SESSION_INVALID');
    });

    it('floors conversation duration in PostgreSQL without losing sub-millisecond precision', async (): Promise<void> => {
      const id = await historySeed({
        reason: 'hangup',
        started: '2020-01-01T12:00:00.000999Z',
        ended: '2020-01-01T12:00:01.000000Z',
      });
      const { body } = await request(app.getHttpServer())
        .get('/calls/history/' + id)
        .auth(await token(0), { type: 'bearer' })
        .expect(200);

      expect(body.item).toMatchObject({ outcome: 'completed', duration_seconds: 0 });
    });
  });

  async function offer(id: string, negotiationId = randomUUID()): Promise<string> {
    await calls.withSelectedPeer(actors[0], id, async (tx, call): Promise<void> => {
      await calls.registerNegotiation(tx, call, negotiationId);
    });

    return negotiationId;
  }

  async function active(): Promise<{ id: string; negotiation: string }> {
    const call = await calls.create(actors[0], actors[1].userId);

    const { call_id: callCallId } = call;

    await calls.accept(actors[1], callCallId);
    const { call_id: callCallId2 } = call;
    const negotiation = await offer(callCallId2);

    const { call_id: callCallId3 } = call;

    await calls.connected(actors[0], callCallId3, negotiation);
    const { call_id: callCallId4 } = call;

    await calls.connected(actors[1], callCallId4, negotiation);

    const { call_id: callCallId5 } = call;

    return { id: callCallId5, negotiation };
  }

  it('atomically creates version 0, two busy participants and provider jobs', async (): Promise<void> => {
    await devices.setPushToken(
      actors[1].userId,
      actors[1].sessionId,
      actors[1].deviceId,
      'aabb',
      'sandbox',
    );
    const call = await calls.create(actors[0], actors[1].userId);

    expect(call).toMatchObject({ state: 'ringing', version: 0 });
    const { rowCount: queryResultRowCount } = await pool.query(
      'SELECT * FROM gchat_direct_call_participants',
    );

    expect(queryResultRowCount).toBe(2);
    const { rows: jobsRows } = await pool.query(
      'SELECT kind,snapshot FROM gchat_direct_call_deliveries ORDER BY kind',
    );

    expect(jobsRows).toEqual([
      { kind: 'state', snapshot: call },
      { kind: 'voip', snapshot: null },
    ]);
    await expect(calls.create(actors[2], actors[1].userId)).rejects.toMatchObject({
      code: 'RECIPIENT_BUSY',
    });
    await expect(calls.create(actors[0], actors[2].userId)).rejects.toMatchObject({
      code: 'CALLER_BUSY',
    });
  });

  it('resolves simultaneous cross-calls to exactly one call', async (): Promise<void> => {
    const results = await Promise.allSettled([
      calls.create(actors[0], actors[1].userId),
      calls.create(actors[1], actors[0].userId),
    ]);

    const { filter: resultsFilter } = results;

    expect(resultsFilter.bind(results)((r): boolean => r.status === 'fulfilled')).toHaveLength(1);
    const { rowCount: queryResultRowCount2 } = await pool.query('SELECT * FROM gchat_direct_calls');

    expect(queryResultRowCount2).toBe(1);
  });

  it('reconciles an expired foreign reservation without removing a live call', async (): Promise<void> => {
    const call = await calls.create(actors[0], actors[1].userId);
    const key = prefix + 'direct-calls:busy:' + actors[0].userId;

    await redis.set(key, randomUUID(), { EX: 60 });
    await calls.restoreReservations();
    const { call_id: callCallId6 } = call;

    expect(await redis.get(key)).toBe(callCallId6);
    const { call_id: callCallId7 } = call;
    const { state: getResultState } = await calls.get(actors[0], callCallId7);

    expect(getResultState).toBe('ringing');
  });

  it('lets an admin without membership call and the recipient accept', async (): Promise<void> => {
    await pool.query("UPDATE gchat_users SET role='admin' WHERE id=$1", [actors[0].userId]);
    await pool.query('DELETE FROM gchat_group_members WHERE user_id=$1', [actors[0].userId]);
    const call = await calls.create(actors[0], actors[1].userId);

    const { state: callState } = call;

    expect(callState).toBe('ringing');
    const { call_id: callCallId8 } = call;
    const { state: acceptResultState } = await calls.accept(actors[1], callCallId8);

    expect(acceptResultState).toBe('connecting');
  });

  it('keeps self, disabled recipient and busy checks for admins without membership', async (): Promise<void> => {
    await pool.query("UPDATE gchat_users SET role='admin' WHERE id=$1", [actors[0].userId]);
    await pool.query('DELETE FROM gchat_group_members WHERE user_id=$1', [actors[0].userId]);
    await expect(calls.create(actors[0], actors[0].userId)).rejects.toMatchObject({
      code: 'CALL_NOT_ALLOWED',
    });
    await pool.query('UPDATE gchat_users SET disabled_at=now() WHERE id=$1', [actors[1].userId]);
    await expect(calls.create(actors[0], actors[1].userId)).rejects.toMatchObject({
      code: 'CALL_NOT_ALLOWED',
    });
    await pool.query('UPDATE gchat_users SET disabled_at=null WHERE id=$1', [actors[1].userId]);
    await calls.create(actors[1], actors[2].userId);
    await expect(calls.create(actors[0], actors[1].userId)).rejects.toMatchObject({
      code: 'RECIPIENT_BUSY',
    });
  });

  it('does not grant ordinary callers access just because the recipient is an admin', async (): Promise<void> => {
    await pool.query("UPDATE gchat_users SET role='admin' WHERE id=$1", [actors[1].userId]);
    await pool.query('DELETE FROM gchat_group_members WHERE user_id=$1', [actors[0].userId]);
    await expect(calls.create(actors[0], actors[1].userId)).rejects.toMatchObject({
      code: 'CALL_NOT_ALLOWED',
    });
  });

  it('rechecks the current caller role inside the creation transaction', async (): Promise<void> => {
    await pool.query("UPDATE gchat_users SET role='admin' WHERE id=$1", [actors[0].userId]);
    await pool.query('DELETE FROM gchat_group_members WHERE user_id=$1', [actors[0].userId]);
    const reserve = presence.reserve.bind(presence);
    const changed = jest
      .spyOn(presence, 'reserve')
      .mockImplementationOnce(async (id, users): ReturnType<DirectCallsPresence['reserve']> => {
        await pool.query("UPDATE gchat_users SET role='user' WHERE id=$1", [actors[0].userId]);

        return reserve(id, users);
      });

    try {
      await expect(calls.create(actors[0], actors[1].userId)).rejects.toMatchObject({
        code: 'CALL_NOT_ALLOWED',
      });
      const { rowCount: queryResultRowCount3 } = await pool.query(
        'SELECT 1 FROM gchat_direct_calls',
      );

      expect(queryResultRowCount3).toBe(0);
      expect(await redis.get(prefix + 'direct-calls:busy:' + actors[0].userId)).toBeNull();
    } finally {
      changed.mockRestore();
    }
  });

  it('does not reveal busy state without common membership', async (): Promise<void> => {
    await calls.create(actors[0], actors[1].userId);
    await pool.query('DELETE FROM gchat_group_members WHERE user_id=$1', [actors[2].userId]);
    await expect(calls.create(actors[2], actors[1].userId)).rejects.toMatchObject({
      code: 'CALL_NOT_ALLOWED',
    });
  });

  it('keeps PostgreSQL uniqueness effective after Redis reserves disappear', async (): Promise<void> => {
    await calls.create(actors[0], actors[1].userId);
    await redis.del([
      prefix + 'direct-calls:busy:' + actors[0].userId,
      prefix + 'direct-calls:busy:' + actors[1].userId,
    ]);
    await expect(calls.create(actors[2], actors[1].userId)).rejects.toMatchObject({
      code: 'RECIPIENT_BUSY',
    });
    const { rowCount: queryResultRowCount4 } = await pool.query('SELECT * FROM gchat_direct_calls');

    expect(queryResultRowCount4).toBe(1);
  });

  it('selects exactly one recipient device and preserves terminal outcomes on retries', async (): Promise<void> => {
    const other = { ...actors[1], sessionId: randomUUID() };

    await pool.query(
      'INSERT INTO gchat_auth_sessions(id,user_id,refresh_token_hash) VALUES($1,$2,$3)',
      [other.sessionId, other.userId, 'unused'],
    );
    other.deviceId = await devices.bind(other.userId, other.sessionId, null);
    const call = await calls.create(actors[0], actors[1].userId);
    const { call_id: callCallId9 } = call;
    const results = await Promise.allSettled([
      calls.accept(actors[1], callCallId9),
      calls.accept(other, callCallId9),
    ]);

    const { filter: resultsFilter2 } = results;

    expect(resultsFilter2.bind(results)((r): boolean => r.status === 'fulfilled')).toHaveLength(1);
    const { rows: queryResultRows2 } = await pool.query(
      "SELECT session_id FROM gchat_direct_call_participants WHERE role='recipient'",
    );
    const selected = queryResultRows2[0].session_id;
    const winner = selected === other.sessionId ? other : actors[1];
    const loser = selected === other.sessionId ? actors[1] : other;

    const { call_id: callCallId10 } = call;

    await expect(calls.accept(winner, callCallId10)).resolves.toMatchObject({
      state: 'connecting',
      version: 1,
    });
    const { call_id: callCallId11 } = call;

    await expect(calls.end(loser, callCallId11)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const { call_id: callCallId12 } = call;

    await expect(calls.get(loser, callCallId12)).resolves.toMatchObject({ state: 'connecting' });
    const { call_id: callCallId13 } = call;

    await calls.end(winner, callCallId13);
    const { call_id: callCallId14 } = call;

    await expect(calls.cancel(actors[0], callCallId14)).resolves.toMatchObject({
      state: 'ended',
      end_reason: 'hangup',
      version: 2,
    });
  });

  it('requires two confirmations of the current attempt without extending the deadline', async (): Promise<void> => {
    const call = await calls.create(actors[0], actors[1].userId);
    const { call_id: callCallId15 } = call;
    const accepted = await calls.accept(actors[1], callCallId15);
    const { call_id: callCallId16 } = call;
    const old = await offer(callCallId16);

    const { call_id: callCallId17 } = call;

    await calls.connected(actors[0], callCallId17, old);
    const { call_id: callCallId18 } = call;
    const next = await offer(callCallId18);

    const { call_id: callCallId19 } = call;

    await expect(calls.connected(actors[1], callCallId19, old)).rejects.toMatchObject({
      code: 'CALL_STATE_CONFLICT',
    });
    const { call_id: callCallId20 } = call;
    const { connecting_deadline: acceptedConnectingDeadline } = accepted;

    await expect(calls.connected(actors[1], callCallId20, next)).resolves.toMatchObject({
      state: 'connecting',
      connecting_deadline: acceptedConnectingDeadline,
      version: 1,
    });
    const { call_id: callCallId21 } = call;

    await expect(calls.connected(actors[0], callCallId21, next)).resolves.toMatchObject({
      state: 'active',
      version: 2,
    });
  });

  it('versions recovery responses, ignores old sequences and requires both current-window acknowledgements', async (): Promise<void> => {
    const { id } = await active();
    const opened = await calls.ping(actors[0], {
      call_id: id,
      sequence: 1,
      audio_connected: false,
      recovery_id: null,
    });

    expect(opened).toMatchObject({ state: 'active', version: 3 });
    const { recovery_id: openedRecoveryId } = opened;

    expect(openedRecoveryId).not.toBeNull();
    const { recovery_id: openedRecoveryId2 } = opened;

    await expect(
      calls.ping(actors[1], { call_id: id, sequence: 1, audio_connected: true, recovery_id: null }),
    ).resolves.toMatchObject({ version: 3, recovery_id: openedRecoveryId2 });
    const { recovery_id: openedRecoveryId3 } = opened;

    await calls.ping(actors[0], {
      call_id: id,
      sequence: 2,
      audio_connected: true,
      recovery_id: openedRecoveryId3,
    });
    const { recovery_id: openedRecoveryId4 } = opened;

    await expect(
      calls.ping(actors[1], {
        call_id: id,
        sequence: 1,
        audio_connected: true,
        recovery_id: openedRecoveryId4,
      }),
    ).resolves.toMatchObject({ version: 3, recovery_id: openedRecoveryId4 });
    const { recovery_id: openedRecoveryId5 } = opened;

    await expect(
      calls.ping(actors[1], {
        call_id: id,
        sequence: 2,
        audio_connected: true,
        recovery_id: openedRecoveryId5,
      }),
    ).resolves.toMatchObject({ version: 4, recovery_id: null });
    const { started_at: endResultStartedAt } = await calls.end(actors[0], id);

    expect(endResultStartedAt).not.toBeNull();
  });

  it('prioritizes an expired deadline over accept, and recovery deadline over a confirming ping', async (): Promise<void> => {
    const ringing = await calls.create(actors[0], actors[1].userId);

    const { call_id: ringingCallId } = ringing;

    await pool.query(
      "UPDATE gchat_direct_calls SET ringing_deadline=now()-interval '1 second' WHERE id=$1",
      [ringingCallId],
    );
    const { call_id: ringingCallId2 } = ringing;

    await expect(calls.accept(actors[1], ringingCallId2)).rejects.toMatchObject({
      code: 'CALL_STATE_CONFLICT',
    });
    const { call_id: ringingCallId3 } = ringing;

    await expect(calls.get(actors[0], ringingCallId3)).resolves.toMatchObject({
      state: 'ended',
      end_reason: 'no_answer',
    });
    const { id } = await active();
    const recovery = await calls.ping(actors[0], {
      call_id: id,
      sequence: 1,
      audio_connected: false,
      recovery_id: null,
    });

    await pool.query(
      "UPDATE gchat_direct_calls SET recovery_deadline=now()-interval '1 second' WHERE id=$1",
      [id],
    );
    const { recovery_id: recoveryRecoveryId } = recovery;

    await expect(
      calls.ping(actors[0], {
        call_id: id,
        sequence: 2,
        audio_connected: true,
        recovery_id: recoveryRecoveryId,
      }),
    ).rejects.toMatchObject({ code: 'CALL_STATE_CONFLICT' });
    await expect(calls.get(actors[1], id)).resolves.toMatchObject({
      state: 'ended',
      end_reason: 'connection_lost',
    });
  });

  it('detects session revocation without an open WebSocket', async (): Promise<void> => {
    const { id } = await active();

    await pool.query('DELETE FROM gchat_auth_sessions WHERE id=$1', [actors[0].sessionId]);
    await calls.sweep(true);
    await expect(calls.get(actors[1], id)).resolves.toMatchObject({
      state: 'ended',
      end_reason: 'session_revoked',
    });
    await expect(calls.current(actors[1])).resolves.toBeNull();
  });

  it('issues temporary TURN credentials only for selected accepted participants', async (): Promise<void> => {
    const call = await calls.create(actors[0], actors[1].userId);

    const { call_id: callCallId22 } = call;

    await expect(calls.iceConfig(actors[0], callCallId22)).rejects.toMatchObject({
      code: 'CALL_STATE_CONFLICT',
    });
    const { call_id: callCallId23 } = call;

    await calls.accept(actors[1], callCallId23);
    const { call_id: callCallId24 } = call;
    const config = await calls.iceConfig(actors[0], callCallId24);
    const { ice_servers: configIceServers } = config;
    const ice = configIceServers[0];

    expect(ice.credential).toBe(
      createHmac('sha1', process.env.DIRECT_CALLS_TURN_SHARED_SECRET!)
        .update(ice.username)
        .digest('base64'),
    );
    const { expires_at: configExpiresAt } = config;

    expect(Date.parse(configExpiresAt) - Date.now()).toBeGreaterThan(3500000);
    const { call_id: callCallId25 } = call;

    await expect(calls.get(actors[2], callCallId25)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('keeps token replacements safe from late provider invalidation', async (): Promise<void> => {
    const a = actors[1];

    await devices.setPushToken(a.userId, a.sessionId, a.deviceId, 'aabb', 'sandbox');
    const old = await devices.resolveVoipTarget(a.deviceId, a.sessionId);

    await devices.setPushToken(a.userId, a.sessionId, a.deviceId, 'ccdd', 'sandbox');
    const { version: oldVersion } = old!;

    await devices.invalidateVoipTarget(a.deviceId, oldVersion);
    const { token: resolveVoipTargetResultToken } =
      (await devices.resolveVoipTarget(a.deviceId, a.sessionId)) ?? {};

    expect(resolveVoipTargetResultToken).toBe('ccdd');
    await expect(devices.bind(a.userId, a.sessionId, actors[0].deviceId)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('expires processing leases and refuses a stale completion token', async (): Promise<void> => {
    const call = await calls.create(actors[0], actors[1].userId);
    const [first] = await store.claim('state');

    expect(first.snapshot).toEqual(call);
    await pool.query(
      "UPDATE gchat_direct_call_deliveries SET lease_until=now()-interval '1 second' WHERE id=$1",
      [first.id],
    );
    const [second] = await store.claim('state');

    await store.complete(first.id, first.leaseToken!);
    const { rows: queryResultRows3 } = await pool.query(
      'SELECT status FROM gchat_direct_call_deliveries WHERE id=$1',
      [first.id],
    );

    expect(queryResultRows3[0].status).toBe('processing');
    await store.complete(second.id, second.leaseToken!);
    const { rows: queryResultRows4 } = await pool.query(
      'SELECT status FROM gchat_direct_call_deliveries WHERE id=$1',
      [first.id],
    );

    expect(queryResultRows4[0].status).toBe('done');
  });

  it('reschedules Web Push after 2.5 seconds without reviving cancelled jobs or stale leases', async (): Promise<void> => {
    const call = await calls.create(actors[0], actors[1].userId);

    const { call_id: callCallId26 } = call;

    await pool.query(
      `INSERT INTO gchat_direct_call_deliveries (call_id,kind,version,device_id,session_id)
       VALUES ($1,'web_push',0,$2,$3)`,
      [callCallId26, actors[1].deviceId, actors[1].sessionId],
    );
    const [first] = await store.claim('web_push');

    await pool.query(
      "UPDATE gchat_direct_call_deliveries SET lease_until=now()-interval '1 second' WHERE id=$1",
      [first.id],
    );
    const [second] = await store.claim('web_push');

    await store.repeatWebPush(first.id, first.leaseToken!);
    expect(await store.claim('web_push')).toEqual([]);

    const before = Date.now();

    await store.repeatWebPush(second.id, second.leaseToken!);
    const after = Date.now();
    const { rows: queryResultRows5 } = await pool.query(
      'SELECT * FROM gchat_direct_call_deliveries WHERE id=$1',
      [first.id],
    );
    const row = queryResultRows5[0];

    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(0);
    expect(row.next_attempt_at.getTime()).toBeGreaterThanOrEqual(before + 2500);
    expect(row.next_attempt_at.getTime()).toBeLessThanOrEqual(after + 2500);
    expect(await store.claim('web_push')).toEqual([]);

    await pool.query(
      "UPDATE gchat_direct_call_deliveries SET next_attempt_at=now()-interval '1 second' WHERE id=$1",
      [first.id],
    );
    const [third] = await store.claim('web_push');

    const { call_id: callCallId27 } = call;

    await calls.accept(actors[1], callCallId27);
    await store.repeatWebPush(third.id, third.leaseToken!);
    const { rows: queryResultRows6 } = await pool.query(
      'SELECT status FROM gchat_direct_call_deliveries WHERE id=$1',
      [first.id],
    );

    expect(queryResultRows6[0].status).toBe('cancelled');
    expect(await store.claim('web_push')).toEqual([]);
  });

  it('resolves an unknown create commit without releasing or duplicating the call', async (): Promise<void> => {
    const original = db.db.transaction.bind(db.db);
    const spy = jest.spyOn(db.db, 'transaction');

    // Auth session snapshot, then the preliminary account transaction.
    spy.mockImplementationOnce(original);
    spy.mockImplementationOnce(original);
    spy.mockImplementationOnce(async (callback: any): Promise<any> => {
      await original(callback);

      throw new Error('connection lost after commit');
    });

    try {
      const call = await calls.create(actors[0], actors[1].userId);

      const { rows: queryResultRows7 } = await pool.query('SELECT id FROM gchat_direct_calls');
      const { call_id: callCallId28 } = call;

      expect(queryResultRows7).toEqual([{ id: callCallId28 }]);
      const { call_id: callCallId29 } = call;

      expect(await redis.get(prefix + 'direct-calls:busy:' + actors[0].userId)).toBe(callCallId29);
    } finally {
      spy.mockRestore();
    }
  });

  it('keeps committed pings after a Redis projection failure and restores their order after restart', async (): Promise<void> => {
    const { id } = await active();
    const projection = jest
      .spyOn(presence, 'project')
      .mockRejectedValueOnce(new Error('projection failed'));

    try {
      await calls.ping(actors[0], {
        call_id: id,
        sequence: 3,
        audio_connected: false,
        recovery_id: null,
      });
    } finally {
      projection.mockRestore();
    }

    const restarted = new DirectCallsService(
      new DirectCallsRepository(db, error),
      auth,
      groups,
      devices,
      presence,
      config,
      error,
      new LoggerService(),
    );
    const { recovery_id: stateRecoveryId } = await restarted.ping(actors[0], {
      call_id: id,
      sequence: 2,
      audio_connected: true,
      recovery_id: null,
    });

    expect(stateRecoveryId).not.toBeNull();
    const { rows: queryResultRows8 } = await pool.query(
      "SELECT last_sequence,audio_connected FROM gchat_direct_call_participants WHERE call_id=$1 AND role='caller'",
      [id],
    );

    expect(queryResultRows8[0]).toMatchObject({ last_sequence: '3', audio_connected: false });
  });

  it('does not treat an unavailable dependency as session revocation', async (): Promise<void> => {
    const { id } = await active();
    const checking = jest.spyOn(auth, 'checkSession').mockRejectedValue(error.serviceUnavailable());

    try {
      await calls.sweep(true);
    } finally {
      checking.mockRestore();
    }

    const { rows: queryResultRows9 } = await pool.query(
      'SELECT state,end_reason FROM gchat_direct_calls WHERE id=$1',
      [id],
    );

    expect(queryResultRows9[0]).toEqual({ state: 'active', end_reason: null });
  });

  it('ends disabled accounts independently from WebSocket and retains immutable state jobs', async (): Promise<void> => {
    const call = await calls.create(actors[0], actors[1].userId);

    await pool.query('UPDATE gchat_users SET disabled_at=now() WHERE id=$1', [actors[0].userId]);
    await calls.sweep(true);
    const { call_id: callCallId30 } = call;
    const { end_reason: getResultEndReason } = await calls.get(actors[1], callCallId30);

    expect(getResultEndReason).toBe('account_disabled');
    const { rows: queryResultRows10 } = await pool.query(
      "SELECT snapshot FROM gchat_direct_call_deliveries WHERE version=0 AND kind='state'",
    );

    expect(queryResultRows10[0].snapshot).toEqual(call);
  });

  it('prunes only ended calls after retention, and delays inactive device cleanup while referenced', async (): Promise<void> => {
    const call = await calls.create(actors[0], actors[1].userId);

    const { call_id: callCallId31 } = call;

    await calls.cancel(actors[0], callCallId31);
    await pool.query('DELETE FROM gchat_auth_sessions WHERE id=$1', [actors[0].sessionId]);
    await pool.query(
      "UPDATE gchat_device_sessions SET inactive_since=now()-interval '31 days' WHERE session_id=$1",
      [actors[0].sessionId],
    );
    await devices.cleanup(new Set([actors[0].sessionId]));
    const { rowCount: queryResultRowCount5 } = await pool.query(
      'SELECT 1 FROM gchat_device_sessions WHERE session_id=$1',
      [actors[0].sessionId],
    );

    expect(queryResultRowCount5).toBe(1);
    const { call_id: callCallId32 } = call;

    await pool.query(
      "UPDATE gchat_direct_calls SET ended_at=now()-interval '31 days' WHERE id=$1",
      [callCallId32],
    );
    await calls.cleanup();
    const { call_id: callCallId33 } = call;

    await expect(calls.get(actors[1], callCallId33)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const { rowCount: queryResultRowCount6 } = await pool.query(
      'SELECT 1 FROM gchat_device_sessions WHERE session_id=$1',
      [actors[0].sessionId],
    );

    expect(queryResultRowCount6).toBe(0);
    const unfinished = await calls.create(actors[1], actors[2].userId);

    const { call_id: unfinishedCallId } = unfinished;

    await pool.query(
      "UPDATE gchat_direct_calls SET created_at=now()-interval '40 days' WHERE id=$1",
      [unfinishedCallId],
    );
    await calls.cleanup();
    const { call_id: unfinishedCallId2 } = unfinished;
    const { rowCount: queryResultRowCount7 } = await pool.query(
      'SELECT 1 FROM gchat_direct_calls WHERE id=$1',
      [unfinishedCallId2],
    );

    expect(queryResultRowCount7).toBe(1);
  });

  it('locks membership against concurrent deletion until creation transaction finishes', async (): Promise<void> => {
    let release!: () => void;
    let acquired!: () => void;
    const held = new Promise<void>((resolve): void => {
      acquired = resolve;
    });
    const finished = new Promise<void>((resolve): void => {
      release = resolve;
    });
    const locking = db.db.transaction(async (tx): Promise<void> => {
      expect(await groups.lockCommonGroup(tx, actors[0].userId, actors[1].userId)).toBe(true);
      acquired();
      await finished;
    });

    await held;
    let deleted = false;
    const deleting = (async () => {
      await pool.query('DELETE FROM gchat_group_members WHERE group_id=$1 AND user_id=$2', [
        groupId,
        actors[1].userId,
      ]);

      deleted = true;
    })();

    try {
      await new Promise((resolve): void => {
        setTimeout(resolve, 40);
      });
      expect(deleted).toBe(false);
    } finally {
      release();
      await locking;
      await deleting;
    }

    await expect(groups.hasCommonGroup(actors[0].userId, actors[1].userId)).resolves.toBe(false);
  });
});
