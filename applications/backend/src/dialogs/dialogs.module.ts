import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { DevicesModule } from '../devices/devices.module.js';
import { GroupsModule } from '../groups/groups.module.js';
import { DialogsController } from './dialogs.controller.js';
import { DialogsCrypto } from './dialogs.crypto.js';
import { DialogsEvents } from './dialogs.events.js';
import { DialogsLimits } from './dialogs.limits.js';
import { DialogsService } from './dialogs.service.js';

@Module({
  imports: [DatabaseModule, AuthModule, GroupsModule, DevicesModule],
  controllers: [DialogsController],
  providers: [DialogsService, DialogsCrypto, DialogsLimits, DialogsEvents],
  exports: [DialogsService, DialogsEvents],
})
export class DialogsModule {}
