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
    const { [0]: resultsFirst, [1]: results1 } = results;
    const checks: ReadinessResponseDto['checks'] = {
      database: resultsFirst.status === 'fulfilled' ? 'up' : 'down',
      redis: results1.status === 'fulfilled' ? 'up' : 'down',
    };
    const { every: resultsEvery } = results;
    const healthy = resultsEvery.bind(results)((result): boolean => result.status === 'fulfilled');
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
