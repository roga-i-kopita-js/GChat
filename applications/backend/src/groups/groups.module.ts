import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module.js';
import { GroupsRepository } from './groups.repository.js';
import { GroupsService } from './groups.service.js';

@Module({
  imports: [DatabaseModule],
  providers: [GroupsRepository, GroupsService],
  exports: [GroupsService],
})
export class GroupsModule {}
