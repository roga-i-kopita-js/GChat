import 'reflect-metadata';

import { ConfigService } from '@nestjs/config';
import { asc, gt } from 'drizzle-orm';
import pg from 'pg';

import { DatabaseService } from '../database/database.service.js';
import { validateDatabaseUrl } from '../database/database-url.js';
import { ErrorService } from '../error/error.service.js';
import { LoggerService } from '../logger/logger.service.js';
import { DialogsCrypto } from './dialogs.crypto.js';
import { dialogMessages } from './dialogs.schema.js';
/** Offline operator audit: stop writers and use the isolated restored database. No registry writes. */
async function verify(): Promise<void> {
  validateDatabaseUrl(process.env.DATABASE_URL);
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 5000,
    statement_timeout: 5000,
  });

  try {
    const database = new DatabaseService(pool);
    const crypto = new DialogsCrypto(
      new ConfigService(process.env),
      database,
      new ErrorService(),
      new LoggerService(),
    );
    const result = await database.db.transaction(
      async (tx): Promise<{ verified_messages: number; key_ids: string[] }> => {
        const keys = new Set<string>();
        let verified = 0;
        let last: string | undefined;

        for (;;) {
          const rows = await tx
            .select()
            .from(dialogMessages)
            .where(last ? gt(dialogMessages.id, last) : undefined)
            .orderBy(asc(dialogMessages.id))
            .limit(500);

          const { length: rowsLength } = rows ?? {};

          if (!rowsLength) {
            break;
          }

          for (const row of rows) {
            crypto.decrypt(row);
            keys.add(row.encryptionKeyId);
            verified++;
          }

          const { at: rowsAt } = rows;

          last = rowsAt.bind(rows)(-1)!.id;
        }

        return { verified_messages: verified, key_ids: [...keys].sort() };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );

    console.log(JSON.stringify({ result: 'verified', ...result }));
  } finally {
    await pool.end();
  }
}
(async () => {
  try {
    return await verify();
  } catch (cause) {
    console.error('Dialog history verification failed; access must remain closed');
    process.exitCode = 1;
  }
})();
