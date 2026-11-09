import 'reflect-metadata';

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';

import { DatabaseModule } from '../database/database.module.js';
import { DatabaseService } from '../database/database.service.js';
import { validateDatabaseUrl } from '../database/database-url.js';
import { AppError } from '../error/app.error.js';
import { ErrorModule } from '../error/error.module.js';
import { GroupsRepository } from '../groups/groups.repository.js';
import { GroupsService } from '../groups/groups.service.js';
import { LoggerModule } from '../logger/logger.module.js';
import { parseAdminArgs, readHiddenPassword } from './admin-cli.input.js';
import { AuthAccounts, type SafeAccount } from './auth.accounts.js';
import { AuthCrypto } from './auth.crypto.js';
import { AuthSessions } from './auth.sessions.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: (env: Record<string, unknown>): Record<string, unknown> => {
        validateDatabaseUrl(env.DATABASE_URL);

        return env;
      },
    }),
    LoggerModule.forRoot(),
    ErrorModule,
    DatabaseModule,
  ],
  providers: [AuthCrypto, AuthSessions, AuthAccounts, GroupsRepository, GroupsService],
})
class AdminCliModule {}

async function main(): Promise<void> {
  const input = parseAdminArgs(process.argv.slice(2));
  const password = await readHiddenPassword();
  const app = await NestFactory.createApplicationContext(AdminCliModule, {
    logger: false,
    abortOnError: false,
  });

  try {
    const { get: appGet } = app;
    const accounts = appGet.bind(app)(AuthAccounts);
    const { get: appGet2 } = app;
    const groups = appGet2.bind(app)(GroupsService);
    const group = input.group === undefined ? undefined : groups.normalizeName(input.group);
    const prepared = await accounts.prepare({ ...input, password });
    const { get: appGet3 } = app;
    const account = await appGet3
      .bind(app)(DatabaseService)
      .db.transaction(async (tx): Promise<SafeAccount> => {
        const account = await accounts.create(tx, prepared, 'admin');

        if (group !== undefined) {
          const { id: accountId } = account;

          await groups.assign(tx, accountId, group);
        }

        return account;
      });

    const { login: accountLogin, id: accountId2 } = account;

    process.stdout.write(`Администратор создан: ${accountLogin} (${accountId2})\n`);
  } finally {
    const { close: appClose } = app;

    await appClose.bind(app)();
  }
}

(async () => {
  try {
    return await main();
  } catch (cause) {
    const error: unknown = cause;

    process.stderr.write(
      error instanceof AppError
        ? `${error.code}: ${error.message}\n`
        : 'Не удалось создать администратора. Проверьте параметры, терминал и конфигурацию. Результат записи может быть неизвестен.\n',
    );
    process.exitCode = 1;
  }
})();
