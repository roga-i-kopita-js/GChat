import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';

@Controller()
export class HealthcheckController {
  constructor(private readonly database: DatabaseService) {}

  @Get('health')
  health() {
    return { status: 'ok', service: 'gchat-backend' };
  }

  @Get('ready')
  async ready() {
    try {
      await this.database.ping();
      return {
        status: 'ok',
        service: 'gchat-backend',
        checks: { database: 'up' },
      };
    } catch {
      throw new ServiceUnavailableException({
        status: 'error',
        service: 'gchat-backend',
        checks: { database: 'down' },
      });
    }
  }
}
