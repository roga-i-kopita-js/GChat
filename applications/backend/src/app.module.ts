import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnvironment } from './config/environment.js';
import { RedisModule } from './redis/redis.module.js';
import { HealthcheckModule } from './healthcheck/healthcheck.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      validate: validateEnvironment,
    }),
    RedisModule.forRoot(),
    HealthcheckModule,
  ],
})
export class AppModule {}
