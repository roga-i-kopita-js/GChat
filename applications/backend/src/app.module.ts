import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AuthModule } from './auth/auth.module.js';
import { validateEnvironment } from './config/environment.js';
import { ErrorModule } from './error/error.module.js';
import { HealthcheckModule } from './healthcheck/healthcheck.module.js';
import { LoggerModule } from './logger/logger.module.js';
import { PushModule } from './push/push.module.js';
import { RedisModule } from './redis/redis.module.js';
import { SignalingModule } from './signaling/signaling.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      validate: validateEnvironment,
    }),
    LoggerModule.forRoot(),
    ErrorModule,
    RedisModule.forRoot(),
    HealthcheckModule,
    AuthModule,
    SignalingModule,
    PushModule,
  ],
})
export class AppModule {}
