import { readMigrationFiles } from 'drizzle-orm/migrator';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

import { validateDatabaseUrl } from './database-url.js';

/** Runs the standard Drizzle migrator without bootstrapping Nest or Redis. */
export async function runMigrations(databaseUrl: unknown, migrationsFolder: string): Promise<void> {
  const url = validateDatabaseUrl(databaseUrl);
  // Check artifacts before connecting. Missing or corrupt files are an error, not an empty history.
  const migrations = readMigrationFiles({ migrationsFolder });

  if (migrations.length === 0) {
    return;
  }

  const pool = new pg.Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 5000 });

  try {
    await migrate(drizzle({ client: pool }), { migrationsFolder });
  } finally {
    await pool.end();
  }
}
