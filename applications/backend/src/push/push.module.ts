import { Module } from '@nestjs/common';

import { DevicesModule } from '../devices/devices.module.js';
import { DirectCallsModule } from '../direct-calls/direct-calls.module.js';
import { PushClient } from './push.client.js';
import { PushWorker } from './push.worker.js';
import { WebPushClient } from './web-push.client.js';
import { WebPushWorker } from './web-push.worker.js';

@Module({
  imports: [DevicesModule, DirectCallsModule],
  providers: [PushClient, PushWorker, WebPushClient, WebPushWorker],
})
export class PushModule {}
