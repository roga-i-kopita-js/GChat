import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { GroupsModule } from '../groups/groups.module.js';
import { AdminGuard } from './admin.guard.js';
import { BackofficeController } from './backoffice.controller.js';
import { BackofficeService } from './backoffice.service.js';

@Module({
  imports: [AuthModule, GroupsModule, DatabaseModule],
  controllers: [BackofficeController],
  providers: [BackofficeService, AdminGuard],
})
export class BackofficeModule {}
