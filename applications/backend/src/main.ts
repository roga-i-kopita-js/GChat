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
  const { get: appGet } = app;
  const logger = new LoggerService(appGet.bind(app)(LoggerSettings));

  const { useLogger: appUseLogger } = app;

  appUseLogger.bind(app)(logger);
  setupDialogBodyLimit(app);
  const { get: appGet2 } = app;
  const config = appGet2.bind(app)(ConfigService);

  const { get: appGet3, useWebSocketAdapter: appUseWebSocketAdapter } = app;

  appUseWebSocketAdapter.bind(app)(new SignalingAdapter(app, appGet3.bind(app)(AuthService)));
  setupSwagger(app);
  setupServerWeb(app, process.env.GCHAT_WEB_ROOT);
  const { enableShutdownHooks: appEnableShutdownHooks } = app;

  appEnableShutdownHooks.bind(app)();
  const { listen: appListen } = app;

  await appListen.bind(app)(config.getOrThrow<number>('PORT'), config.getOrThrow<string>('HOST'));
  logger.log(
    'HTTP server started',
    { host: config.getOrThrow<string>('HOST'), port: config.getOrThrow<number>('PORT') },
    'Bootstrap',
  );
}

(async () => {
  try {
    return await bootstrap();
  } catch (cause) {
    const error: unknown = cause;

    bootstrapLogger.error('Backend startup failed', { error }, 'Bootstrap');
    process.exitCode = 1;
  }
})();
