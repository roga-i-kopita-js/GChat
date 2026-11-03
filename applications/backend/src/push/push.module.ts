import { Module } from '@nestjs/common';

import { DevicesModule } from '../devices/devices.module.js';
import { DirectCallsModule } from '../direct-calls/direct-calls.module.js';
import { PushClient } from './push.client.js';
import { PushWorker } from './push.worker.js';

@Module({ imports: [DevicesModule, DirectCallsModule], providers: [PushClient, PushWorker] })
export class PushModule {}
