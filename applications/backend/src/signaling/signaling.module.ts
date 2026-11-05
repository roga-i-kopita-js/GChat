import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { DevicesModule } from '../devices/devices.module.js';
import { DirectCallsModule } from '../direct-calls/direct-calls.module.js';
import { NativeWebsocketPolicyService } from './native-websocket-policy.service.js';
import { SignalingGateway } from './signaling.gateway.js';
import { SignalingWorker } from './signaling.worker.js';

@Module({
  imports: [AuthModule, DevicesModule, DirectCallsModule, DatabaseModule],
  providers: [SignalingGateway, SignalingWorker, NativeWebsocketPolicyService],
})
export class SignalingModule {}
