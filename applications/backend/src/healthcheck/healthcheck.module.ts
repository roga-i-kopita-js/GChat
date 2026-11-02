import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module.js';
import { HealthcheckController } from './healthcheck.controller.js';

@Module({
  imports: [DatabaseModule],
  controllers: [HealthcheckController],
})
export class HealthcheckModule {}
