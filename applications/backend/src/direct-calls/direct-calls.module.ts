import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { DevicesModule } from '../devices/devices.module.js';
import { GroupsModule } from '../groups/groups.module.js';
import { CallHistoryController } from './call-history.controller.js';
import { CallHistoryLimits } from './call-history.limits.js';
import { CallHistoryService } from './call-history.service.js';
import { DirectCallsDeliveryStore } from './direct-calls.delivery-store.js';
import { DirectCallsPresence } from './direct-calls.presence.js';
import { DirectCallsRepository } from './direct-calls.repository.js';
import { DirectCallsService } from './direct-calls.service.js';
import { DirectCallsWorker } from './direct-calls.worker.js';

@Module({
  imports: [AuthModule, DatabaseModule, DevicesModule, GroupsModule],
  controllers: [CallHistoryController],
  providers: [
    CallHistoryLimits,
    CallHistoryService,
    DirectCallsRepository,
    DirectCallsService,
    DirectCallsPresence,
    DirectCallsDeliveryStore,
    DirectCallsWorker,
  ],
  exports: [DirectCallsService, DirectCallsDeliveryStore],
})
export class DirectCallsModule {}
