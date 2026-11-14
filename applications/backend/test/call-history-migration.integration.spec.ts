import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import pg from 'pg';

import { runMigrations } from '../src/database/migrations.js';

const integration = process.env.CALLS_INTEGRATION_DATABASE_URL ? describe : describe.skip;

integration('call history migration over the previous schema', (): void => {
  const name = 'gchat_history_migration_' + randomUUID().replaceAll('-', '');
  let admin: pg.Pool;
  let database: pg.Pool;
  let folder: string;
  let url: string;
  let backfill: string;
  const call = randomUUID();
  const ringing = randomUUID();

  beforeAll(async (): Promise<void> => {
    admin = new pg.Pool({
      connectionString: process.env.CALLS_INTEGRATION_DATABASE_URL,
      connectionTimeoutMillis: 2000,
    });
    await admin.query(`CREATE DATABASE "${name}"`);
    const target = new URL(process.env.CALLS_INTEGRATION_DATABASE_URL!);

    target.pathname = '/' + name;
    url = target.href;
    database = new pg.Pool({ connectionString: url, statement_timeout: 5000 });
    folder = await mkdtemp(join(tmpdir(), 'gchat-history-migration-'));
    await cp(resolve('drizzle'), folder, { recursive: true });
    const journal = JSON.parse(await readFile(join(folder, 'meta/_journal.json'), 'utf8'));
    const historyIndex = journal.entries.findIndex(
      (entry: { tag: string }): boolean => entry.tag === '0008_call_history',
    );

    expect(historyIndex).toBeGreaterThan(0);
    journal.entries = journal.entries.slice(0, historyIndex);
    await writeFile(join(folder, 'meta/_journal.json'), JSON.stringify(journal));
    await runMigrations(url, folder);
    const caller = randomUUID();
    const recipient = randomUUID();

    await database.query(
      "INSERT INTO gchat_users(id,login,display_name,password_hash) VALUES($1,'one','One','unused'),($2,'two','Two','unused')",
      [caller, recipient],
    );
    await database.query(
      `INSERT INTO gchat_direct_calls(id,caller_id,recipient_id,state,created_at,started_at,ended_at,end_reason,version,ringing_deadline)
      VALUES($1,$3,$4,'ended','2020-01-01T00:00:00.123456Z','2020-01-01T00:00:01Z','2020-01-01T00:05:00Z','hangup',7,null),
      ($2,$3,$4,'ringing',now(),null,null,null,0,now()+interval '30 seconds')`,
      [call, ringing, caller, recipient],
    );
    const migration = await readFile(resolve('drizzle/0008_call_history.sql'), 'utf8');
    const { slice: migrationResult1, indexOf: migrationResult2 } = migration;

    backfill = migrationResult1.bind(migration)(
      migrationResult2.bind(migration)('-- Copy retained terminal metadata'),
    );
  });

  afterAll(async (): Promise<void> => {
    await database?.end();

    try {
      await admin?.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    } finally {
      await admin?.end();
    }

    if (folder) {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it('copies only completed calls losslessly and survives repeated migration, backfill and technical deletion', async (): Promise<void> => {
    await runMigrations(url, resolve('drizzle'));
    await runMigrations(url, resolve('drizzle'));
    await database.query(backfill);
    const { rows } = await database.query(
      "SELECT call_id,version,to_char(created_at at time zone 'UTC','YYYY-MM-DD HH24:MI:SS.US') AS exact FROM gchat_direct_call_history",
    );

    expect(rows).toEqual([{ call_id: call, version: '7', exact: '2020-01-01 00:00:00.123456' }]);
    await database.query('DELETE FROM gchat_direct_calls WHERE id=$1', [call]);
    const { rows: retained } = await database.query(
      'SELECT call_id FROM gchat_direct_call_history',
    );

    expect(retained).toEqual([{ call_id: call }]);
    const { rows: current } = await database.query('SELECT id FROM gchat_direct_calls');

    expect(current).toEqual([{ id: ringing }]);
  });

  it('checks immutable backfill conflicts and schema constraints', async (): Promise<void> => {
    await database.query(`INSERT INTO gchat_direct_calls(id,caller_id,recipient_id,state,created_at,started_at,ended_at,end_reason,version)
      SELECT call_id,caller_id,recipient_id,'ended',created_at,started_at,ended_at,'session_revoked',version FROM gchat_direct_call_history`);
    await expect(database.query(backfill)).rejects.toThrow(
      'Call history backfill integrity failure',
    );
    await expect(
      database.query('UPDATE gchat_direct_call_history SET caller_id=recipient_id'),
    ).rejects.toThrow();
    await expect(
      database.query('UPDATE gchat_direct_call_history SET version=-1'),
    ).rejects.toThrow();
    await expect(
      database.query("UPDATE gchat_direct_call_history SET end_reason='other'"),
    ).rejects.toThrow();
    await expect(
      database.query(
        "UPDATE gchat_direct_call_history SET ended_at=created_at-interval '1 second'",
      ),
    ).rejects.toThrow();
    await expect(
      database.query(
        "UPDATE gchat_direct_call_history SET started_at=ended_at+interval '1 second'",
      ),
    ).rejects.toThrow();
    await expect(database.query('DELETE FROM gchat_users')).rejects.toThrow();
    const refs = await database.query(
      "SELECT confrelid::regclass::text AS target FROM pg_constraint WHERE conrelid='gchat_direct_call_history'::regclass AND contype='f'",
    );
    const { rows: refsResult3 } = refs;

    expect(refsResult3).toEqual([{ target: 'gchat_users' }, { target: 'gchat_users' }]);
  });
});
