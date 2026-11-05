import { jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';

import { DevicesService } from '../devices/devices.service.js';
import { DirectCallsDeliveryStore } from '../direct-calls/direct-calls.delivery-store.js';
import { DirectCallsService } from '../direct-calls/direct-calls.service.js';
import { LoggerService } from '../logger/logger.service.js';
import { PushClient } from './push.client.js';
import { PushWorker } from './push.worker.js';

describe('VoIP outbox processing', (): void => {
  function fixture(apnsEnabled = true): any {
    const job = {
      id: 'job',
      callId: 'call',
      deviceId: 'device',
      sessionId: 'session',
      leaseToken: 'lease',
      attempts: 2,
    };
    const store = {
      claim: jest.fn<DirectCallsDeliveryStore['claim']>().mockResolvedValue([job as any]),
      complete: jest.fn<DirectCallsDeliveryStore['complete']>().mockResolvedValue(undefined),
      retry: jest.fn<DirectCallsDeliveryStore['retry']>().mockResolvedValue(undefined),
    };
    const devices = {
      resolveVoipTarget: jest.fn<DevicesService['resolveVoipTarget']>().mockResolvedValue({
        userId: 'user',
        deviceId: 'device',
        sessionId: 'session',
        version: 'version',
        token: 'secret',
        environment: 'sandbox',
      } as any),
      invalidateVoipTarget: jest
        .fn<DevicesService['invalidateVoipTarget']>()
        .mockResolvedValue(undefined),
    };
    const calls = {
      get: jest.fn<DirectCallsService['get']>().mockResolvedValue({
        state: 'ringing',
        ringing_deadline: new Date(Date.now() + 60000).toISOString(),
        call_id: 'call',
      } as any),
    };
    const client = {
      send: jest.fn<PushClient['send']>().mockResolvedValue({ status: 200, retryAfterSeconds: 0 }),
    };
    const worker = new PushWorker(
      store as any,
      calls as any,
      devices as any,
      client as any,
      new ConfigService({ APNS_ENABLED: apnsEnabled, APNS_ENVIRONMENT: 'sandbox' }),
      new LoggerService(),
    );

    return { worker, store, devices, calls, client };
  }

  it('does not consume VoIP jobs when disabled', async (): Promise<void> => {
    jest.useFakeTimers();
    const f = fixture(false);

    try {
      f.worker.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(1000);
      expect(f.store.claim).not.toHaveBeenCalled();
      expect(f.client.send).not.toHaveBeenCalled();
    } finally {
      await f.worker.onModuleDestroy();
      jest.useRealTimers();
    }
  });

  it('marks provider acceptance done without changing call state', async (): Promise<void> => {
    const f = fixture();

    await f.worker.tick();
    expect(f.store.complete).toHaveBeenCalledWith('job', 'lease');
    expect(f.client.send).toHaveBeenCalledTimes(1);
  });

  it('cancels an obsolete call or revoked target without sending', async (): Promise<void> => {
    const f = fixture();

    f.calls.get.mockResolvedValue({ state: 'ended' });
    await f.worker.tick();
    expect(f.store.complete).toHaveBeenCalledWith('job', 'lease', 'cancelled');
    expect(f.client.send).not.toHaveBeenCalled();
    f.devices.resolveVoipTarget.mockResolvedValue(undefined);
    await f.worker.tick();
    expect(f.client.send).not.toHaveBeenCalled();
  });

  it('retries unknown results and throttling with the current lease and Retry-After', async (): Promise<void> => {
    const f = fixture();

    f.client.send.mockRejectedValueOnce(new Error('unknown send result'));
    await f.worker.tick();
    expect(f.store.retry).toHaveBeenCalledWith('job', 'lease', 2);
    f.client.send.mockResolvedValue({ status: 429, retryAfterSeconds: 19 });
    await f.worker.tick();
    expect(f.store.retry).toHaveBeenCalledWith('job', 'lease', 2, 19);
  });

  it('invalidates only the exact token version with the provider timestamp', async (): Promise<void> => {
    const f = fixture();

    f.client.send.mockResolvedValue({
      status: 410,
      reason: 'Unregistered',
      timestamp: 123,
      retryAfterSeconds: 0,
    });
    await f.worker.tick();
    expect(f.devices.invalidateVoipTarget).toHaveBeenCalledWith('device', 'version', 123);
    expect(f.store.complete).toHaveBeenCalledWith('job', 'lease', 'cancelled');
  });

  it('keeps user tokens after a credentials or topic error', async (): Promise<void> => {
    const f = fixture();

    f.client.send.mockResolvedValue({
      status: 403,
      reason: 'InvalidProviderToken',
      retryAfterSeconds: 0,
    });
    await f.worker.tick();
    expect(f.devices.invalidateVoipTarget).not.toHaveBeenCalled();
    expect(f.store.complete).toHaveBeenCalledWith('job', 'lease', 'cancelled');
  });
});
