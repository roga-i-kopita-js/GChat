import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { DevicesService } from './devices.service.js';

@Module({
  imports: [AuthModule, DatabaseModule],
  providers: [DevicesService],
  exports: [DevicesService],
})
export class DevicesModule {}
