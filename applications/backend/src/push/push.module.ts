import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { DevicesModule } from '../devices/devices.module.js';
import { DialogsModule } from '../dialogs/dialogs.module.js';
import { DirectCallsModule } from '../direct-calls/direct-calls.module.js';
import { DialogPushWorker } from './dialog-push.worker.js';
import { PushClient } from './push.client.js';
import { PushWorker } from './push.worker.js';
import { WebPushClient } from './web-push.client.js';
import { WebPushWorker } from './web-push.worker.js';

@Module({
  imports: [AuthModule, DevicesModule, DirectCallsModule, DialogsModule],
  providers: [DialogPushWorker, PushClient, PushWorker, WebPushClient, WebPushWorker],
})
export class PushModule {}
