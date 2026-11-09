import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

import { jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import pg from 'pg';
import { createClient } from 'redis';
import request from 'supertest';

import { AuthCrypto } from '../src/auth/auth.crypto.js';
import { AuthGuard, type AuthIdentity } from '../src/auth/auth.guard.js';
import { AuthLimits } from '../src/auth/auth.limits.js';
import { AuthRepository } from '../src/auth/auth.repository.js';
import { AuthService } from '../src/auth/auth.service.js';
import { AuthSessions } from '../src/auth/auth.sessions.js';
import { validateEnvironment } from '../src/config/environment.js';
import { DatabaseService } from '../src/database/database.service.js';
import { runMigrations } from '../src/database/migrations.js';
import { DevicesService } from '../src/devices/devices.service.js';
import { setupDialogBodyLimit } from '../src/dialogs/dialogs.body.js';
import { DialogsController } from '../src/dialogs/dialogs.controller.js';
import { DialogsCrypto } from '../src/dialogs/dialogs.crypto.js';
import { type DialogNotice, DialogsEvents } from '../src/dialogs/dialogs.events.js';
import { dialogRateScript, DialogsLimits } from '../src/dialogs/dialogs.limits.js';
import { DialogsService } from '../src/dialogs/dialogs.service.js';
import { ErrorModule } from '../src/error/error.module.js';
import { ErrorService } from '../src/error/error.service.js';
import { GroupsRepository } from '../src/groups/groups.repository.js';
import { GroupsService } from '../src/groups/groups.service.js';
import { LoggerModule } from '../src/logger/logger.module.js';
import { LoggerService } from '../src/logger/logger.service.js';
import { RedisService } from '../src/redis/redis.service.js';

const integration =
  process.env.DIALOGS_INTEGRATION_DATABASE_URL && process.env.DIALOGS_INTEGRATION_REDIS_URL
    ? describe
    : describe.skip;

integration('Dialogs with isolated PostgreSQL, Redis and real HTTP guard', (): void => {
  const name = 'gchat_dialogs_' + randomUUID().replaceAll('-', '');
  const prefix = 'gchat:dialogs-test:' + randomUUID() + ':';
  const error = new ErrorService();
  let admin: pg.Pool;
  let pool: pg.Pool;
  let redis: ReturnType<typeof createClient>;
  let database: DatabaseService;
  let auth: AuthService;
  let devices: DevicesService;
  let service: DialogsService;
  let crypto: DialogsCrypto;
  let authCrypto: AuthCrypto;
  let events: DialogsEvents;
  let config: ConfigService;
  let limits: DialogsLimits;
  let app: NestExpressApplication;
  let actors: (AuthIdentity & { deviceId: string; token: string })[];
  let group: string;
  let notices: DialogNotice[];

  beforeAll(async (): Promise<void> => {
    admin = new pg.Pool({
      connectionString: process.env.DIALOGS_INTEGRATION_DATABASE_URL,
      connectionTimeoutMillis: 2000,
    });
    await admin.query(`CREATE DATABASE "${name}"`);
    const url = new URL(process.env.DIALOGS_INTEGRATION_DATABASE_URL!);

    url.pathname = '/' + name;
    await runMigrations(url.href, resolve('drizzle'));
    await runMigrations(url.href, resolve('drizzle'));
    pool = new pg.Pool({ connectionString: url.href, max: 12, statement_timeout: 4000 });
    database = new DatabaseService(pool);
    redis = createClient({ url: process.env.DIALOGS_INTEGRATION_REDIS_URL });
    redis.on('error', (): void => {});
    await redis.connect();
    config = new ConfigService(
      validateEnvironment({
        ...process.env,
        APNS_ENABLED: 'false',
        DATABASE_URL: url.href,
        REDIS_URL: process.env.DIALOGS_INTEGRATION_REDIS_URL,
        REDIS_KEY_PREFIX: prefix,
      }),
    );
    authCrypto = new AuthCrypto(config, error);
    auth = new AuthService(
      new AuthRepository(database, error),
      authCrypto,
      new AuthSessions(database, error),
      new AuthLimits(error, config),
      error,
    );
    devices = new DevicesService(database, auth, error, config);
    crypto = new DialogsCrypto(config, database, error, new LoggerService());
    await crypto.onModuleInit();
    limits = new DialogsLimits(new RedisService(redis, config), error);
    events = new DialogsEvents();
    events.subscribe(async (notice): Promise<void> => {
      notices.push(notice);
    });
    service = new DialogsService(
      database,
      auth,
      devices,
      new GroupsService(new GroupsRepository(database, error)),
      crypto,
      limits,
      error,
      events,
    );
    const module = await Test.createTestingModule({
      imports: [LoggerModule.forRoot(), ErrorModule],
      controllers: [DialogsController],
      providers: [
        AuthGuard,
        { provide: AuthService, useValue: auth },
        { provide: DialogsService, useValue: service },
      ],
    }).compile();

    const { createNestApplication: moduleCreateNestApplication } = module;

    app = moduleCreateNestApplication.bind(module)<NestExpressApplication>({
      bodyParser: false,
      logger: false,
    });
    setupDialogBodyLimit(app);
    await app.init();
  }, 20000);
  beforeEach(async (): Promise<void> => {
    await pool.query('TRUNCATE gchat_users,gchat_groups,gchat_devices,gchat_dialogs CASCADE');
    await pool.query('UPDATE gchat_dialog_encryption_keys SET encryption_attempts=0');

    for await (const keys of redis.scanIterator({ MATCH: prefix + '*' })) {
      if (keys.length) {
        await redis.del(keys);
      }
    }

    actors = [];
    notices = [];

    for (let i = 0; i < 3; i++) {
      const userId = randomUUID();
      const sessionId = randomUUID();

      await pool.query(
        'INSERT INTO gchat_users(id,login,display_name,password_hash) VALUES($1,$2,$2,$3)',
        [userId, 'user' + i, 'unused'],
      );
      await pool.query(
        'INSERT INTO gchat_auth_sessions(id,user_id,refresh_token_hash) VALUES($1,$2,$3)',
        [sessionId, userId, 'unused'],
      );
      const account = await new AuthRepository(database, error).byId(userId);
      const { access_token: issueResultAccessToken } = await authCrypto.issue(account!, sessionId);
      const token = issueResultAccessToken;

      const deviceIdValue = await devices.bind(userId, sessionId, null);

      actors.push({
        userId,
        sessionId,
        deviceId: deviceIdValue,
        token,
        role: 'user',
        login: 'user' + i,
        displayName: 'user' + i,
      });
    }

    const { rows: queryResultRows } = await pool.query(
      "INSERT INTO gchat_groups(name) VALUES('dialogs') RETURNING id",
    );

    group = queryResultRows[0].id;

    for (const actor of actors) {
      await pool.query('INSERT INTO gchat_group_members VALUES($1,$2)', [group, actor.userId]);
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
  const input = (
    text = 'secret',
  ): { client_message_id: string; content: { kind: 'text'; text: string } } => ({
    client_message_id: randomUUID(),
    content: { kind: 'text', text },
  });

  async function dialog(): Promise<string> {
    const { dialog: createResultDialog } = await service.create(actors[0], actors[1].userId);

    return createResultDialog.dialog_id;
  }
  async function resetRates(): Promise<void> {
    for await (const keys of redis.scanIterator({ MATCH: prefix + 'dialogs:rate:*' })) {
      if (keys.length) {
        await redis.del(keys);
      }
    }
  }
  it('returns peer names and incoming-only unread state consistently across create/list/get', async (): Promise<void> => {
    const [a, b, outsider] = actors;
    const { dialog } = await service.create(a!, b!.userId);

    expect(dialog.peer_display_name).toBe('user1');
    expect(dialog.has_unread_messages).toBe(false);
    const { dialog: createResultDialog2 } = await service.create(a!, b!.userId);

    expect(createResultDialog2).toMatchObject({
      peer_display_name: 'user1',
      has_unread_messages: false,
    });
    await service.send(a!, dialog.dialog_id, input('own'));
    const { dialog: getResultDialog } = await service.get(a!, dialog.dialog_id);

    expect(getResultDialog.has_unread_messages).toBe(false);
    const { dialog: getResultDialog2 } = await service.get(b!, dialog.dialog_id);

    expect(getResultDialog2.has_unread_messages).toBe(true);
    const first = await service.send(b!, dialog.dialog_id, input('incoming'));
    const second = await service.send(b!, dialog.dialog_id, input('also incoming'));

    const { message: firstMessage } = first;

    await service.read(a!, dialog.dialog_id, firstMessage.sequence);
    const { dialog: getResultDialog3 } = await service.get(a!, dialog.dialog_id);

    expect(getResultDialog3.has_unread_messages).toBe(true);
    const { message: secondMessage } = second;

    await service.read(a!, dialog.dialog_id, secondMessage.sequence);
    await service.send(a!, dialog.dialog_id, input('own after read'));
    const { dialog: getResultDialog4 } = await service.get(a!, dialog.dialog_id);

    expect(getResultDialog4.has_unread_messages).toBe(false);
    await pool.query('UPDATE gchat_users SET display_name=$1,disabled_at=now() WHERE id=$2', [
      'Renamed',
      b!.userId,
    ]);
    await pool.query('DELETE FROM gchat_group_members WHERE user_id=$1', [a!.userId]);
    const { dialogs: listResultDialogs } = await service.list(a!, 30, 0);

    expect(listResultDialogs[0]).toMatchObject({
      peer_display_name: 'Renamed',
      has_unread_messages: false,
    });
    const { dialog: getResultDialog5 } = await service.get(a!, dialog.dialog_id);

    expect(getResultDialog5.peer_display_name).toBe('Renamed');
    await expect(service.get(outsider!, dialog.dialog_id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('returns the exact last message across list/get/repeated create without marking it read', async (): Promise<void> => {
    const [a, b] = actors;
    const { dialog: empty } = await service.create(a!, b!.userId);

    expect(empty.last_message).toBeNull();
    const text = 'Начало\n😀 ' + 'д'.repeat(3900);
    const { message: own } = await service.send(a!, empty.dialog_id, input(text));

    const { dialog: ownMetadata } = await service.get(a!, empty.dialog_id);
    const { dialog: repeatedMetadata } = await service.create(b!, a!.userId);

    expect(ownMetadata.last_message).toEqual(own);
    expect(repeatedMetadata.last_message).toEqual(own);
    const { dialogs: previewList } = await service.list(b!, 30, 0);

    expect(previewList[0]).toMatchObject({
      last_message: own,
      last_read_sequence: 0,
      has_unread_messages: true,
    });
    const { message: sticker } = await service.send(b!, empty.dialog_id, {
      client_message_id: randomUUID(),
      content: { kind: 'sticker', sticker_id: 'animal-pals-v1-cat' },
    });

    const { dialogs: stickerList } = await service.list(a!, 30, 0);

    expect(stickerList[0]?.last_message).toEqual(sticker);
    const [, snapshot] = await Promise.all([
      service.send(a!, empty.dialog_id, input('concurrent')),
      service.get(b!, empty.dialog_id),
    ]);

    expect(snapshot.dialog.last_message?.sequence).toBe(snapshot.dialog.last_sequence);
  });

  it('creates a single permanent pair under concurrent requests with 201/200 semantics', async (): Promise<void> => {
    const results = await Promise.all([
      service.create(actors[0], actors[1].userId),
      service.create(actors[1], actors[0].userId),
    ]);

    const { map: resultsMap } = results;

    expect(new Set(resultsMap.bind(results)((r): string => r.dialog.dialog_id)).size).toBe(1);
    const { filter: resultsFilter } = results;

    expect(resultsFilter.bind(results)((r): boolean => r.created)).toHaveLength(1);
    const { [0]: resultsFirst } = results;

    expect(resultsFirst.dialog).toEqual(
      expect.objectContaining({
        last_sequence: 0,
        last_read_sequence: 0,
        peer_last_read_sequence: 0,
        last_message_at: null,
      }),
    );
    const { [0]: resultsFirst2 } = results;

    expect(Object.keys(resultsFirst2.dialog)).not.toContain('can_send');
  });
  it('serializes sends, deduplicates across devices, preserves original content and emits after commit only once', async (): Promise<void> => {
    const id = await dialog();
    const body = input('first');
    const result = await Promise.all([
      service.send(actors[0], id, body),
      service.send(actors[0], id, { ...body, content: { kind: 'text', text: 'changed' } }),
    ]);

    const { [0]: resultFirst, [1]: result1 } = result;

    expect(resultFirst.message).toEqual(result1.message);
    const { filter: resultFilter } = result;

    expect(resultFilter.bind(result)((r): boolean => r.created)).toHaveLength(1);
    const second = await service.send(actors[0], id, input('same'));
    const third = await service.send(actors[0], id, input('same'));

    const { message: secondMessage2 } = second;
    const { message: thirdMessage } = third;

    expect([secondMessage2.sequence, thirdMessage.sequence]).toEqual([2, 3]);
    await Promise.resolve();
    expect(notices).toHaveLength(3);
    const { rows: queryResultRows2 } = await pool.query(
      'SELECT * FROM gchat_dialog_messages WHERE dialog_id=$1 ORDER BY sequence',
      [id],
    );
    const stored = queryResultRows2;

    expect(stored[0].sender_device_id).toBe(actors[0].deviceId);
    expect(stored[0].ciphertext).toBeInstanceOf(Buffer);
    expect(stored[0].content).toBeUndefined();
    const anotherSid = randomUUID();

    await pool.query(
      'INSERT INTO gchat_auth_sessions(id,user_id,refresh_token_hash) VALUES($1,$2,$3)',
      [anotherSid, actors[0].userId, 'unused'],
    );
    await devices.bind(actors[0].userId, anotherSid, null);
    const { created: sendResultCreated } = await service.send(
      { ...actors[0], sessionId: anotherSid },
      id,
      body,
    );

    expect(sendResultCreated).toBe(false);
    const { [0]: resultFirst2 } = result;
    const { rows: queryResultRows5 } = await pool.query(
      'SELECT sender_device_id FROM gchat_dialog_messages WHERE id=$1',
      [resultFirst2.message.message_id],
    );

    expect(queryResultRows5[0].sender_device_id).toBe(actors[0].deviceId);
  });
  it('returns both directions with exclusive boundaries and monotone shared read positions', async (): Promise<void> => {
    const id = await dialog();

    for (let i = 1; i <= 4; i++) {
      await service.send(actors[0], id, input('message ' + i));
    }

    const page = await service.history(actors[1], id, 2, 0);

    const { messages: pageMessages } = page;

    expect(pageMessages.map((m): number => m.sequence)).toEqual([1, 2]);
    const { has_more: pageHasMore } = page;

    expect(pageHasMore).toBe(true);
    const { messages: historyResultMessages } = await service.history(actors[1], id, 2, 2);

    expect(historyResultMessages.map((m): number => m.sequence)).toEqual([3, 4]);
    const { messages: historyResultMessages2 } = await service.history(
      actors[1],
      id,
      2,
      undefined,
      4,
    );

    expect(historyResultMessages2.map((m): number => m.sequence)).toEqual([3, 2]);
    const { messages: historyResultMessages3 } = await service.history(actors[1], id, 30);

    expect(historyResultMessages3.map((m): number => m.sequence)).toEqual([4, 3, 2, 1]);
    await Promise.all([service.read(actors[1], id, 4), service.read(actors[1], id, 2)]);
    expect(await service.read(actors[1], id, 1)).toEqual({ last_read_sequence: 4 });
    const { dialog: getResultDialog6 } = await service.get(actors[0], id);

    expect(getResultDialog6).toEqual(
      expect.objectContaining({
        last_sequence: 4,
        last_read_sequence: 0,
        peer_last_read_sequence: 4,
      }),
    );
    const { messages: historyResultMessages4 } = await service.history(actors[0], id, 30);

    expect(historyResultMessages4.every((m): boolean => m.status === 'read')).toBe(true);
    await expect(service.read(actors[1], id, 5)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      fields: [{ field: 'sequence', code: 'INVALID' }],
    });
    const emitted = notices.filter((n): boolean => n.event.type === 'dialog.read_updated');

    expect(emitted).toHaveLength(1);
    expect(JSON.stringify(emitted[0].event)).not.toContain('content');
  });
  it('keeps inaccessible metadata but denies history, sends and foreign administrators', async (): Promise<void> => {
    const id = await dialog();

    await service.send(actors[0], id, input());
    await pool.query('DELETE FROM gchat_group_members WHERE user_id=$1', [actors[1].userId]);
    const { dialogs: listResultDialogs2 } = await service.list(actors[1], 30, 0);

    expect(listResultDialogs2).toHaveLength(1);
    expect(listResultDialogs2[0]?.last_message).toBeNull();
    const { dialog: getResultDialog7 } = await service.get(actors[1], id);

    expect(getResultDialog7.last_sequence).toBe(1);
    expect(getResultDialog7.last_message).toBeNull();
    expect(await service.permissions(actors[1], id)).toEqual({
      dialogs: { can_read: false, can_send: false },
    });
    await expect(service.history(actors[1], id, 30)).rejects.toMatchObject({
      code: 'DIALOG_NOT_ALLOWED',
    });
    await expect(service.send(actors[1], id, input())).rejects.toMatchObject({
      code: 'DIALOG_NOT_ALLOWED',
    });
    await pool.query("UPDATE gchat_users SET role='admin' WHERE id=$1", [actors[2].userId]);
    await expect(service.get(actors[2], id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(service.get(actors[2], randomUUID())).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await pool.query("UPDATE gchat_users SET role='admin' WHERE id=$1", [actors[0].userId]);
    expect(await service.permissions(actors[1], id)).toEqual({
      dialogs: { can_read: true, can_send: false },
    });
    const { dialog: readableMetadata } = await service.get(actors[1], id);

    expect(readableMetadata.last_message?.content).toEqual({
      kind: 'text',
      text: 'secret',
    });
    await service.read(actors[1], id, 1);
    const { messages: historyResultMessages5 } = await service.history(actors[1], id, 30);

    expect(historyResultMessages5).toHaveLength(1);
    await pool.query('UPDATE gchat_users SET disabled_at=now() WHERE id=$1', [actors[0].userId]);
    await expect(service.history(actors[1], id, 30)).rejects.toMatchObject({
      code: 'DIALOG_NOT_ALLOWED',
    });
    await pool.query('INSERT INTO gchat_group_members VALUES($1,$2)', [group, actors[1].userId]);
    const { messages: historyResultMessages6 } = await service.history(actors[1], id, 30);

    expect(historyResultMessages6).toHaveLength(1);
    await expect(service.send(actors[1], id, input())).rejects.toMatchObject({
      code: 'DIALOG_NOT_ALLOWED',
    });
  });
  it('rechecks session and binding after the HTTP guard and allows cleanup without destroying history', async (): Promise<void> => {
    const id = await dialog();
    const body = input();

    await service.send(actors[0], id, body);
    await pool.query('DELETE FROM gchat_device_sessions WHERE session_id=$1', [
      actors[0].sessionId,
    ]);
    await pool.query('DELETE FROM gchat_devices WHERE id=$1', [actors[0].deviceId]);
    await expect(service.get(actors[0], id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await devices.bind(actors[0].userId, actors[0].sessionId, null);
    const { created: sendResultCreated2 } = await service.send(actors[0], id, body);

    expect(sendResultCreated2).toBe(false);
    const { messages: historyResultMessages7 } = await service.history(actors[0], id, 30);

    expect(historyResultMessages7).toHaveLength(1);
    await pool.query('DELETE FROM gchat_auth_sessions WHERE id=$1', [actors[0].sessionId]);
    await expect(service.get(actors[0], id)).rejects.toMatchObject({ code: 'SESSION_INVALID' });
  });
  it('rolls back sequence and activity on encryption failure but consumes its separately committed budget', async (): Promise<void> => {
    const id = await dialog();
    const encrypt = jest.spyOn(crypto, 'encrypt').mockImplementationOnce((): never => {
      throw new Error('test secret');
    });

    await expect(service.send(actors[0], id, input())).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
    });
    encrypt.mockRestore();
    const { dialog: getResultDialog8 } = await service.get(actors[0], id);

    expect(getResultDialog8.last_sequence).toBe(0);
    const { rows: queryResultRows3 } = await pool.query(
      'SELECT encryption_attempts FROM gchat_dialog_encryption_keys',
    );

    expect(queryResultRows3[0].encryption_attempts).toBe('1');
    const { message: sendResultMessage } = await service.send(actors[0], id, input());

    expect(sendResultMessage.sequence).toBe(1);
  });
  it('does not create new records at exhausted key budget but can still return an authorized retry or read', async (): Promise<void> => {
    const id = await dialog();
    const body = input();
    const first = await service.send(actors[0], id, body);

    await pool.query('UPDATE gchat_dialog_encryption_keys SET encryption_attempts=16777216');
    const { message: sendResultMessage2 } = await service.send(actors[0], id, body);
    const { message: firstMessage2 } = first;

    expect(sendResultMessage2).toEqual(firstMessage2);
    await expect(service.send(actors[0], id, input())).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
    const { messages: historyResultMessages8 } = await service.history(actors[1], id, 30);

    expect(historyResultMessages8).toHaveLength(1);
  });
  it('does not issue a partial history page when any authentication tag is damaged', async (): Promise<void> => {
    const id = await dialog();

    await service.send(actors[0], id, input('one'));
    const { message: secondMessage3 } = await service.send(actors[0], id, input('two'));

    await pool.query(
      "UPDATE gchat_dialog_messages SET auth_tag=decode(repeat('00',16),'hex') WHERE id=$1",
      [secondMessage3.message_id],
    );
    await expect(service.history(actors[0], id, 30, 0)).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
    });
    await expect(service.get(actors[0], id)).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    await expect(service.list(actors[0], 30, 0)).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    await pool.query('DELETE FROM gchat_group_members WHERE user_id=$1', [actors[0].userId]);
    const { dialog: deniedMetadata } = await service.get(actors[0], id);

    expect(deniedMetadata.last_message).toBeNull();
  });
  it('protects an admitted real Dialogs transaction until commit while logout waits', async (): Promise<void> => {
    const id = await dialog();
    let signalLocked!: () => void;
    let release!: () => void;
    const locked = new Promise<void>((resolve): void => {
      signalLocked = resolve;
    });
    const gate = new Promise<void>((resolve): void => {
      release = resolve;
    });
    const original = auth.lockSession.bind(auth);
    const check = jest
      .spyOn(auth, 'lockSession')
      .mockImplementationOnce(async (tx, userId, sid): Promise<void> => {
        await original(tx, userId, sid);
        signalLocked();
        await gate;
      });
    const operation = service.get(actors[0], id);

    await locked;
    let deleted = false;
    const deletion = (async () => {
      await pool.query('DELETE FROM gchat_auth_sessions WHERE id=$1', [actors[0].sessionId]);

      deleted = true;
    })();

    try {
      await pool.query('SELECT 1');
      expect(deleted).toBe(false);
      release();
      const { dialog: resultDialog } = await operation;

      expect(resultDialog.dialog_id).toBe(id);
      await deletion;
      await expect(service.get(actors[0], id)).rejects.toMatchObject({ code: 'SESSION_INVALID' });
    } finally {
      release();
      check.mockRestore();
      await deletion;
    }
  });

  it('bounds whole JSON history pages without truncating message content', async (): Promise<void> => {
    const id = await dialog();

    for (let i = 0; i < 28; i++) {
      await resetRates();
      await service.send(actors[0], id, input('😀'.repeat(4000)));
    }

    const page = await service.history(actors[1], id, 100, 0);

    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(524288);
    const { messages: pageMessages2 } = page;

    expect(pageMessages2.length).toBe(28);
    const { has_more: pageHasMore2 } = page;

    expect(pageHasMore2).toBe(false);

    // JSON escaping creates the worst valid content expansion (control characters).
    for (let i = 0; i < 10; i++) {
      await resetRates();
      await service.send(actors[0], id, input('x' + '\u0001'.repeat(3999)));
    }

    const bounded = await service.history(actors[1], id, 100, 0);

    expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(524288);
    const { has_more: boundedHasMore } = bounded;

    expect(boundedHasMore).toBe(true);
    const { messages: boundedMessages } = bounded;
    const { messages: restMessages } = await service.history(
      actors[1],
      id,
      100,
      boundedMessages.at(-1)!.sequence,
    );
    const { messages: boundedMessages2 } = bounded;

    expect(restMessages.length + boundedMessages2.length).toBe(38);
  });
  it('enforces shared atomic Redis buckets and closed failure behavior', async (): Promise<void> => {
    const results = await Promise.allSettled(
      Array.from({ length: 11 }, (): Promise<void> => limits.check(actors[0].userId, 'send')),
    );

    const { filter: resultsFilter2 } = results;

    expect(resultsFilter2.bind(results)((r): boolean => r.status === 'fulfilled')).toHaveLength(10);
    const { find: resultsFind } = results;
    const rejected = resultsFind.bind(results)((r): boolean => r.status === 'rejected');

    expect(rejected).toMatchObject({ reason: { code: 'RATE_LIMITED', retryAfterSeconds: 1 } });
    await expect(limits.check(actors[0].userId, 'read')).resolves.toBeUndefined();
    const ttl = await redis.ttl(prefix + 'dialogs:rate:' + actors[0].userId + ':send');

    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);
    await redis.set(prefix + 'dialogs:rate:' + actors[1].userId + ':get', 'corrupt');
    await expect(service.list(actors[1], 30, 0)).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
  });
  it('verifies the entire restored history without emitting content and fails closed on a damaged record', async (): Promise<void> => {
    const id = await dialog();

    await service.send(actors[0], id, input('never-print-this-secret'));
    const env = {
      DATABASE_URL: config.getOrThrow<string>('DATABASE_URL'),
      DIALOGS_ACTIVE_KEY_ID: config.getOrThrow<string>('DIALOGS_ACTIVE_KEY_ID'),
      DIALOGS_ENCRYPTION_KEYS: config.getOrThrow<string>('DIALOGS_ENCRYPTION_KEYS'),
    };
    const output = execFileSync(process.execPath, ['dist/dialogs/dialogs.verify.js'], {
      env,
      encoding: 'utf8',
    });

    expect(JSON.parse(output)).toEqual({
      result: 'verified',
      verified_messages: 1,
      key_ids: ['test'],
    });
    expect(output).not.toContain('never-print');
    await pool.query("UPDATE gchat_dialog_messages SET auth_tag=decode(repeat('00',16),'hex')");
    const failure = spawnSync(process.execPath, ['dist/dialogs/dialogs.verify.js'], {
      env,
      encoding: 'utf8',
    });

    expect(failure.status).toBe(1);
    expect(failure.stdout).toBe('');
    expect(failure.stderr).not.toContain('never-print');
  });

  it('retains key fingerprints and budgets across restarts and refuses changed material or aliases', async (): Promise<void> => {
    await crypto.reserve();
    await crypto.onModuleInit();
    const { rows: queryResultRows4 } = await pool.query(
      'SELECT encryption_attempts FROM gchat_dialog_encryption_keys',
    );

    expect(queryResultRows4[0].encryption_attempts).toBe('1');
    const changed = new DialogsCrypto(
      new ConfigService({
        DIALOGS_ACTIVE_KEY_ID: 'test',
        DIALOGS_ENCRYPTION_KEYS: JSON.stringify({ test: randomBytes(32).toString('base64') }),
      }),
      database,
      error,
      new LoggerService(),
    );

    await expect(changed.onModuleInit()).rejects.toThrow(
      'Dialogs key registry initialization failed',
    );
    const old = JSON.parse(config.getOrThrow<string>('DIALOGS_ENCRYPTION_KEYS')).test;
    const alias = new DialogsCrypto(
      new ConfigService({
        DIALOGS_ACTIVE_KEY_ID: 'alias',
        DIALOGS_ENCRYPTION_KEYS: JSON.stringify({ alias: old }),
      }),
      database,
      error,
      new LoggerService(),
    );

    await expect(alias.onModuleInit()).rejects.toThrow(
      'Dialogs key registry initialization failed',
    );
  });

  it.each([
    [5, 10],
    [1, 5],
    [10, 20],
  ])(
    'refills %i/s with capacity %i on deterministic Redis time without rollback-clock credit',
    async (rate, capacity): Promise<void> => {
      const script = dialogRateScript.replace("redis.call('TIME')", '{ARGV[3],ARGV[4]}');
      const key = prefix + 'virtual:' + rate;
      const run = (ms: number): Promise<unknown> =>
        redis.eval(script, {
          keys: [key],
          arguments: [
            String(rate),
            String(capacity),
            String(Math.floor(ms / 1000)),
            String((ms % 1000) * 1000),
          ],
        });

      for (let i = 0; i < capacity; i++) {
        expect(await run(100000)).toBe(0);
      }

      expect(await run(100000)).toBe(Math.ceil(1000 / rate));
      expect(await run(99000)).toBe(Math.ceil(1000 / rate));
      expect(await run(100000 + Math.ceil(1000 / rate))).toBe(0);
      expect(await run(1000000000000)).toBe(0);
      expect(await redis.ttl(key)).toBeLessThanOrEqual(60);
      await redis.del(key);
      expect(await run(1000000000000)).toBe(0);
    },
  );

  it('allocates the last safe sequence, then refuses new writes but still returns that idempotent message', async (): Promise<void> => {
    const id = await dialog();

    await pool.query(
      'UPDATE gchat_dialogs SET last_sequence=9007199254740990,last_message_at=now() WHERE id=$1',
      [id],
    );
    const body = input();
    const last = await service.send(actors[0], id, body);

    const { message: lastMessage } = last;

    expect(lastMessage.sequence).toBe(Number.MAX_SAFE_INTEGER);
    await expect(service.send(actors[0], id, input())).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
    });
    const { message: sendResultMessage3 } = await service.send(actors[0], id, body);
    const { message: lastMessage2 } = last;

    expect(sendResultMessage3).toEqual(lastMessage2);
  });

  it('stores ordinary APNs separately and leaves its version intact on an identical registration', async (): Promise<void> => {
    const actor = actors[0];

    await devices.setApnsToken(actor.userId, actor.sessionId, actor.deviceId, 'AABB', 'sandbox');
    const first = await devices.resolveApnsTarget(actor.deviceId, actor.sessionId);

    await devices.setApnsToken(actor.userId, actor.sessionId, actor.deviceId, 'aabb', 'sandbox');
    const { version: resolveApnsTargetResultVersion } =
      (await devices.resolveApnsTarget(actor.deviceId, actor.sessionId)) ?? {};
    const { version: firstVersion } = first ?? {};

    expect(resolveApnsTargetResultVersion).toBe(firstVersion);
    expect(await devices.listVoipTargets(actor.userId)).toHaveLength(0);
    await devices.setApnsToken(actor.userId, actor.sessionId, actor.deviceId, 'ccdd', 'sandbox');
    const { version: firstVersion2 } = first!;

    await devices.invalidateApnsTarget(actor.deviceId, firstVersion2);
    const { token: resolveApnsTargetResultToken } =
      (await devices.resolveApnsTarget(actor.deviceId, actor.sessionId)) ?? {};

    expect(resolveApnsTargetResultToken).toBe('ccdd');
  });

  it('serves HTTP status, strict DTO/query errors, 413, no-store and Retry-After through the shared filter', async (): Promise<void> => {
    const agent = request(app.getHttpServer());
    const authorization = 'Bearer ' + actors[0].token;
    const created = await agent
      .post('/dialogs')
      .set('Authorization', authorization)
      .send({ peer_id: actors[1].userId });

    const { status: createdStatus } = created;

    expect(createdStatus).toBe(201);
    const { body: createdBody } = created;
    const id = createdBody.dialog.dialog_id;

    const { status: sendResultStatus } = await agent
      .post('/dialogs')
      .set('Authorization', authorization)
      .send({ peer_id: actors[1].userId });

    expect(sendResultStatus).toBe(200);

    for (const query of ['limit=01', 'limit=0', 'offset=1e2', 'limit=1&limit=2']) {
      const { status: setResultStatus } = await agent
        .get('/dialogs?' + query)
        .set('Authorization', authorization);

      expect(setResultStatus).toBe(400);
    }

    for (const body of [{ sequence: '0' }, { sequence: 0, extra: true }]) {
      const { status: sendResultStatus2 } = await agent
        .post('/dialogs/' + id + '/read')
        .set('Authorization', authorization)
        .send(body);

      expect(sendResultStatus2).toBe(400);
    }

    const { body: invalidBody } = await agent
      .post('/dialogs/' + id + '/messages')
      .set('Authorization', authorization)
      .send({ ...input(), content: { kind: 'text', text: 'valid', extra: true } });

    expect(invalidBody.error.code).toBe('VALIDATION_ERROR');
    const huge = JSON.stringify(input('secret'.repeat(12000)));
    const tooLarge = await agent
      .post('/dialogs/' + id + '/messages')
      .set('Authorization', authorization)
      .set('Content-Type', 'application/json')
      .send(huge);

    const { status: tooLargeStatus } = tooLarge;

    expect(tooLargeStatus).toBe(413);
    const { body: tooLargeBody } = tooLarge;

    expect(tooLargeBody).toEqual({
      error: { code: 'PAYLOAD_TOO_LARGE', message: expect.any(String) },
    });
    const { status: compressedStatus } = await agent
      .post('/dialogs/' + id + '/messages')
      .set('Authorization', authorization)
      .set('Content-Type', 'application/json')
      .set('Content-Encoding', 'gzip')
      .serialize((body: any): any => body)
      .send(gzipSync(huge));

    expect(compressedStatus).toBe(413);
    const sent = await agent
      .post('/dialogs/' + id + '/messages')
      .set('Authorization', authorization)
      .send(input());

    const { status: sentStatus } = sent;

    expect(sentStatus).toBe(201);
    const { headers: sentHeaders } = sent;

    expect(sentHeaders['cache-control']).toBe('no-store');
    await resetRates();
    await redis.hSet(prefix + 'dialogs:rate:' + actors[0].userId + ':get', {
      credit_ms: '0',
      updated_at_ms: String(Date.now() + 10000),
    });
    const limited = await agent.get('/dialogs').set('Authorization', authorization);

    const { status: limitedStatus } = limited;

    expect(limitedStatus).toBe(429);
    const { headers: limitedHeaders } = limited;

    expect(Number(limitedHeaders['retry-after'])).toBeGreaterThan(0);
    const { body: getResultBody } = await agent.get('/dialogs');

    expect(getResultBody.error.code).toBe('ACCESS_TOKEN_INVALID');
  });
});
