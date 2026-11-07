import 'reflect-metadata';

import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';

import { AppModule } from './app.module.js';
import { AuthService } from './auth/auth.service.js';
import { setupDialogBodyLimit } from './dialogs/dialogs.body.js';
import { LoggerService } from './logger/logger.service.js';
import { LoggerSettings } from './logger/logger-settings.js';
import { SignalingAdapter } from './signaling/signaling.adapter.js';
import { setupSwagger } from './swagger/setup-swagger.js';
import { setupServerWeb } from './web/setup-server-web.js';

const bootstrapLogger = new LoggerService();

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: bootstrapLogger,
    abortOnError: false,
    bodyParser: false,
  });
  const logger = new LoggerService(app.get(LoggerSettings));

  app.useLogger(logger);
  setupDialogBodyLimit(app);
  const config = app.get(ConfigService);

  app.useWebSocketAdapter(new SignalingAdapter(app, app.get(AuthService)));
  setupSwagger(app);
  setupServerWeb(app, process.env.GCHAT_WEB_ROOT);
  app.enableShutdownHooks();
  await app.listen(config.getOrThrow<number>('PORT'), config.getOrThrow<string>('HOST'));
  logger.log(
    'HTTP server started',
    { host: config.getOrThrow<string>('HOST'), port: config.getOrThrow<number>('PORT') },
    'Bootstrap',
  );
}

bootstrap().catch((error: unknown): void => {
  bootstrapLogger.error('Backend startup failed', { error }, 'Bootstrap');
  process.exitCode = 1;
});
