import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiServiceUnavailableResponse, ApiTags } from '@nestjs/swagger';

import { DatabaseService } from '../database/database.service.js';
import { ReadinessError } from '../error/readiness.error.js';
import { RedisService } from '../redis/redis.service.js';
import { HealthResponseDto, ReadinessResponseDto } from './healthcheck.dto.js';

@ApiTags('Healthcheck')
@Controller()
export class HealthcheckController {
  constructor(
    private readonly database: DatabaseService,
    private readonly redis: RedisService,
  ) {}

  /** Check HTTP application liveness. */
  @Get('health')
  @ApiOperation({ operationId: 'healthcheckHealth' })
  health(): HealthResponseDto {
    return { status: 'ok', service: 'gchat-backend' };
  }

  /** Check PostgreSQL and Redis availability. */
  @Get('ready')
  @ApiServiceUnavailableResponse({
    description: 'PostgreSQL or Redis is unavailable.',
    type: ReadinessResponseDto,
  })
  @ApiOperation({ operationId: 'healthcheckReady' })
  async ready(): Promise<ReadinessResponseDto> {
    const results = await Promise.allSettled([this.database.ping(), this.redis.ping()]);
    const checks: ReadinessResponseDto['checks'] = {
      database: results[0].status === 'fulfilled' ? 'up' : 'down',
      redis: results[1].status === 'fulfilled' ? 'up' : 'down',
    };
    const healthy = results.every((result): boolean => result.status === 'fulfilled');
    const response: ReadinessResponseDto = {
      status: healthy ? 'ok' : 'error',
      service: 'gchat-backend',
      checks,
    };

    if (!healthy) {
      throw new ReadinessError(response);
    }

    return response;
  }
}
