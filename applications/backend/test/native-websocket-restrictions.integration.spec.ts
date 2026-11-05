import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import pg from 'pg';

import { runMigrations } from '../src/database/migrations.js';

const integration = process.env.MIGRATION_INTEGRATION_URL ? describe : describe.skip;

integration('Native WebSocket restrictions storage', (): void => {
  const name = `gchat_bridge_${randomUUID().replaceAll('-', '')}`;
  let admin: pg.Pool;
  let pool: pg.Pool;

  beforeAll(async (): Promise<void> => {
    admin = new pg.Pool({
      connectionString: process.env.MIGRATION_INTEGRATION_URL,
      connectionTimeoutMillis: 3000,
    });
    await admin.query(`CREATE DATABASE "${name}"`);
    const url = new URL(process.env.MIGRATION_INTEGRATION_URL!);

    url.pathname = '/' + name;
    await runMigrations(url.href, resolve('drizzle'));
    await runMigrations(url.href, resolve('drizzle'));
    pool = new pg.Pool({ connectionString: url.href, connectionTimeoutMillis: 3000 });
  });

  afterAll(async (): Promise<void> => {
    await pool?.end();

    if (admin) {
      try {
        await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } finally {
        await admin.end();
      }
    }
  });

  it('creates an empty table and applies the operator script without deleting custom rules', async (): Promise<void> => {
    expect((await pool.query('SELECT * FROM gchat_native_websocket_restrictions')).rows).toEqual(
      [],
    );
    await pool.query(
      "INSERT INTO gchat_native_websocket_restrictions(direction, message_pattern) VALUES ('send', 'future.private')",
    );
    const script = await readFile(resolve('scripts/native-websocket-restrictions.sql'), 'utf8');

    await pool.query(script);
    await pool.query(script);
    expect(
      (
        await pool.query(
          'SELECT direction, message_pattern FROM gchat_native_websocket_restrictions ORDER BY direction, message_pattern',
        )
      ).rows,
    ).toEqual([
      { direction: 'receive', message_pattern: 'call.ice_config' },
      { direction: 'receive', message_pattern: 'device.*' },
      { direction: 'receive', message_pattern: 'rtc.*' },
      { direction: 'send', message_pattern: 'call.*' },
      { direction: 'send', message_pattern: 'device.*' },
      { direction: 'send', message_pattern: 'future.private' },
      { direction: 'send', message_pattern: 'rtc.*' },
    ]);
    await expect(
      pool.query(
        "INSERT INTO gchat_native_websocket_restrictions(direction, message_pattern) VALUES ('send', 'call.*')",
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it.each([
    ['invalid', 'call.get'],
    ['send', ''],
    ['send', '*'],
    ['send', 'call*'],
    ['send', 'call.*.get'],
    ['send', 'Call.get'],
    ['send', 'call.get '],
    ['send', 'call..get'],
    ['send', 'a'.repeat(129)],
  ])('rejects malformed rule %s / %s', async (direction, pattern): Promise<void> => {
    await expect(
      pool.query(
        'INSERT INTO gchat_native_websocket_restrictions(direction, message_pattern) VALUES ($1, $2)',
        [direction, pattern],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
