import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { GroupsController } from './groups.controller.js';
import { GroupsRepository } from './groups.repository.js';
import { GroupsService } from './groups.service.js';

@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [GroupsController],
  providers: [GroupsRepository, GroupsService],
  exports: [GroupsService],
})
export class GroupsModule {}
