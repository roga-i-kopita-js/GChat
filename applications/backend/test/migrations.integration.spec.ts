import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import pg from 'pg';

import { runMigrations } from '../src/database/migrations.js';

// Explicit opt-in. Creates and drops its own uniquely named database.
const integration = process.env.MIGRATION_INTEGRATION_URL ? describe : describe.skip;

integration('Standard Drizzle PostgreSQL migrations', (): void => {
  const name = `gchat_migrations_${randomUUID().replaceAll('-', '')}`;
  let folder: string;
  let admin: pg.Pool;
  let database: pg.Pool;
  let url: string;
  const entries: {
    idx: number;
    version: string;
    when: number;
    tag: string;
    breakpoints: boolean;
  }[] = [];

  async function append(tag: string, sql: string): Promise<void> {
    entries.push({
      idx: entries.length,
      version: '7',
      when: entries.length + 1,
      tag,
      breakpoints: true,
    });
    await writeFile(join(folder, `${tag}.sql`), sql);
    await writeFile(
      join(folder, 'meta/_journal.json'),
      JSON.stringify({ version: '7', dialect: 'postgresql', entries }),
    );
  }

  beforeAll(async (): Promise<void> => {
    folder = await mkdtemp(join(tmpdir(), 'gchat-pg-migrations-'));
    await mkdir(join(folder, 'meta'));
    admin = new pg.Pool({
      connectionString: process.env.MIGRATION_INTEGRATION_URL,
      connectionTimeoutMillis: 3000,
    });
    await admin.query(`CREATE DATABASE "${name}"`);
    const target = new URL(process.env.MIGRATION_INTEGRATION_URL!);

    target.pathname = `/${name}`;
    url = target.href;
    database = new pg.Pool({ connectionString: url, connectionTimeoutMillis: 3000 });
  });

  afterAll(async (): Promise<void> => {
    await database?.end();

    if (admin) {
      try {
        await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } finally {
        await admin.end();
      }
    }

    if (folder) await rm(folder, { recursive: true, force: true });
  });

  it('applies new SQL, skips previously applied migrations, and rolls back a failed batch', async (): Promise<void> => {
    await append(
      '0000_probe',
      'CREATE TABLE migration_probe (id integer PRIMARY KEY); INSERT INTO migration_probe VALUES (1);',
    );
    await runMigrations(url, folder);
    await runMigrations(url, folder);
    expect((await database.query('SELECT * FROM migration_probe')).rows).toEqual([{ id: 1 }]);
    expect(
      (await database.query('SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations'))
        .rows,
    ).toEqual([{ count: 1 }]);

    await append('0001_extend', "ALTER TABLE migration_probe ADD COLUMN label text DEFAULT 'ok';");
    await runMigrations(url, folder);
    expect((await database.query('SELECT label FROM migration_probe')).rows).toEqual([
      { label: 'ok' },
    ]);

    await append(
      '0002_failure',
      'INSERT INTO migration_probe (id) VALUES (2); SELECT * FROM migration_table_that_does_not_exist;',
    );
    await expect(runMigrations(url, folder)).rejects.toThrow();
    expect(
      (await database.query('SELECT count(*)::int AS count FROM migration_probe')).rows,
    ).toEqual([{ count: 1 }]);
    expect(
      (await database.query('SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations'))
        .rows,
    ).toEqual([{ count: 2 }]);
    // A failed run closed its pool and left no hanging connection.
    expect(
      (
        await database.query(
          'SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database()',
        )
      ).rows,
    ).toEqual([{ count: 1 }]);
  });
});
