import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { RedisService } from '../redis/redis.service.js';
import { DatabaseService } from '../database/database.service.js';

@Controller()
export class HealthcheckController {
  constructor(
    private readonly database: DatabaseService,
    private readonly redis: RedisService,
  ) {}

  @Get('health')
  health() {
    return { status: 'ok', service: 'gchat-backend' };
  }

  @Get('ready')
  async ready() {
    const results = await Promise.allSettled([this.database.ping(), this.redis.ping()]);
    const checks = {
      database: results[0].status === 'fulfilled' ? 'up' : 'down',
      redis: results[1].status === 'fulfilled' ? 'up' : 'down',
    };
    const healthy = results.every((result) => result.status === 'fulfilled');
    const response = { status: healthy ? 'ok' : 'error', service: 'gchat-backend', checks };
    if (!healthy) throw new ServiceUnavailableException(response);
    return response;
  }
}
