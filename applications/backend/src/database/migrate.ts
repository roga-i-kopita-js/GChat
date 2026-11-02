import { fileURLToPath } from 'node:url';
import { runMigrations } from './migrations.js';
import { LoggerService } from '../logger/logger.service.js';

const logger = new LoggerService();
const folder = fileURLToPath(new URL('../../drizzle/', import.meta.url));

try {
  await runMigrations(process.env.DATABASE_URL, folder);
  logger.log('Database migrations completed', 'Migrations');
} catch {
  // Driver errors can contain credentials, SQL and data, even when log redaction is disabled.
  logger.error('Database migrations failed; check configuration, migration files and database availability', 'Migrations');
  process.exitCode = 1;
}
