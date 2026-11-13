import { jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';

import { AuthService } from '../auth/auth.service.js';
import { DevicesService } from '../devices/devices.service.js';
import { DirectCallsDeliveryStore } from '../direct-calls/direct-calls.delivery-store.js';
import { DirectCallsService } from '../direct-calls/direct-calls.service.js';
import { LoggerService } from '../logger/logger.service.js';
import { WebPushClient } from './web-push.client.js';
import { WebPushWorker } from './web-push.worker.js';

describe('Web Push outbox processing', (): void => {
  function fixture(webPushEnabled = true): any {
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
      repeatWebPush: jest
        .fn<DirectCallsDeliveryStore['repeatWebPush']>()
        .mockResolvedValue(undefined),
    };
    const devices = {
      resolveWebPushTarget: jest.fn<DevicesService['resolveWebPushTarget']>().mockResolvedValue({
        userId: 'user',
        deviceId: 'device',
        sessionId: 'session',
        version: 'version',
        token: 'secret',
        environment: 'sandbox',
      } as any),
      invalidateWebPushTarget: jest
        .fn<DevicesService['invalidateWebPushTarget']>()
        .mockResolvedValue(undefined),
    };
    const calls = {
      get: jest.fn<DirectCallsService['get']>().mockResolvedValue({
        state: 'ringing',
        ringing_deadline: new Date(Date.now() + 60000).toISOString(),
        call_id: 'call',
        caller_id: 'caller',
      } as any),
    };
    const client = {
      send: jest
        .fn<WebPushClient['send']>()
        .mockResolvedValue({ status: 201, retryAfterSeconds: 0 }),
    };
    const auth = {
      displayName: jest.fn<AuthService['displayName']>().mockResolvedValue('  Андрей  '),
    };
    const worker = new WebPushWorker(
      store as any,
      calls as any,
      devices as any,
      client as any,
      new ConfigService({ WEB_PUSH_ENABLED: webPushEnabled }),
      new LoggerService(),
      auth as any,
    );

    return { worker, store, devices, calls, client, auth };
  }

  it('does not consume Web Push jobs when disabled', async (): Promise<void> => {
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

  it('schedules another notification after provider acceptance', async (): Promise<void> => {
    const f = fixture();

    await f.worker.tick();
    expect(f.store.repeatWebPush).toHaveBeenCalledWith('job', 'lease');
    expect(f.store.complete).not.toHaveBeenCalled();
    expect(f.client.send).toHaveBeenCalledTimes(1);
    expect(f.auth.displayName).toHaveBeenCalledWith('caller');
    expect(f.client.send).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user' }),
      'call',
      expect.any(String),
      'Андрей',
    );
  });

  it.each([undefined, '', '   ', 'я'.repeat(81)])(
    'sends without the caller name when it is unavailable or invalid (%s)',
    async (name): Promise<void> => {
      const f = fixture();

      f.auth.displayName.mockResolvedValue(name);
      await f.worker.tick();
      expect(f.client.send).toHaveBeenCalledWith(
        expect.anything(),
        'call',
        expect.any(String),
        undefined,
      );
      expect(f.store.repeatWebPush).toHaveBeenCalledWith('job', 'lease');
    },
  );

  it('still delivers when the name lookup fails and refreshes the name on repeats', async (): Promise<void> => {
    const f = fixture();

    f.auth.displayName.mockRejectedValueOnce(new Error('unavailable'));
    await f.worker.tick();
    expect(f.client.send).toHaveBeenLastCalledWith(
      expect.anything(),
      'call',
      expect.any(String),
      undefined,
    );
    f.auth.displayName.mockResolvedValue('Новое имя');
    await f.worker.tick();
    expect(f.client.send).toHaveBeenLastCalledWith(
      expect.anything(),
      'call',
      expect.any(String),
      'Новое имя',
    );
  });

  it.each(['connecting', 'active', 'ended'])(
    'stops repeating once the call is %s',
    async (state): Promise<void> => {
      const f = fixture();

      await f.worker.tick();
      f.calls.get.mockResolvedValue({ state });
      await f.worker.tick();
      expect(f.client.send).toHaveBeenCalledTimes(1);
      expect(f.store.repeatWebPush).toHaveBeenCalledTimes(1);
      expect(f.store.complete).toHaveBeenCalledWith('job', 'lease', 'cancelled');
    },
  );

  it('cancels an obsolete call or revoked target without sending', async (): Promise<void> => {
    const f = fixture();

    f.calls.get.mockResolvedValue({ state: 'ended' });
    await f.worker.tick();
    expect(f.store.complete).toHaveBeenCalledWith('job', 'lease', 'cancelled');
    expect(f.client.send).not.toHaveBeenCalled();
    f.calls.get.mockResolvedValue({
      state: 'ringing',
      ringing_deadline: new Date(Date.now() - 1).toISOString(),
    });
    await f.worker.tick();
    expect(f.client.send).not.toHaveBeenCalled();
    f.devices.resolveWebPushTarget.mockResolvedValue(undefined);
    await f.worker.tick();
    expect(f.client.send).not.toHaveBeenCalled();
    expect(f.auth.displayName).not.toHaveBeenCalled();
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

  it('invalidates only the exact subscription version on 404/410', async (): Promise<void> => {
    const f = fixture();

    f.client.send.mockResolvedValue({ status: 410 });
    await f.worker.tick();
    expect(f.devices.invalidateWebPushTarget).toHaveBeenCalledWith('session', 'version');
    expect(f.store.complete).toHaveBeenCalledWith('job', 'lease', 'cancelled');
  });

  it('keeps subscriptions after a configuration error', async (): Promise<void> => {
    const f = fixture();

    f.client.send.mockResolvedValue({
      status: 403,
      retryAfterSeconds: 0,
    });
    await f.worker.tick();
    expect(f.devices.invalidateWebPushTarget).not.toHaveBeenCalled();
    expect(f.store.complete).toHaveBeenCalledWith('job', 'lease', 'cancelled');
  });
});
