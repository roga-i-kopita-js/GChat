import { jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';

import type { DevicesService } from '../devices/devices.service.js';
import { type DialogNotice, DialogsEvents } from '../dialogs/dialogs.events.js';
import type { DialogsService } from '../dialogs/dialogs.service.js';
import { LoggerService } from '../logger/logger.service.js';
import { DialogPushWorker } from './dialog-push.worker.js';
import type { PushClient } from './push.client.js';
import type { WebPushClient } from './web-push.client.js';

function fixture(): any {
  const events = new DialogsEvents();
  const target = {
    userId: 'recipient',
    sessionId: 'sid',
    deviceId: 'device',
    version: 'v1',
    token: 'aabb',
    environment: 'sandbox',
    updatedAt: new Date(0),
  };
  const devices = {
    listApnsTargets: jest.fn<DevicesService['listApnsTargets']>().mockResolvedValue([target]),
    listWebPushTargets: jest.fn<DevicesService['listWebPushTargets']>().mockResolvedValue([]),
    resolveApnsTarget: jest.fn<DevicesService['resolveApnsTarget']>().mockResolvedValue(target),
    invalidateApnsTarget: jest
      .fn<DevicesService['invalidateApnsTarget']>()
      .mockResolvedValue(undefined),
  };
  const dialogs = { canDeliver: jest.fn<DialogsService['canDeliver']>().mockResolvedValue(true) };
  const apns = {
    send: jest.fn<PushClient['send']>().mockResolvedValue({ status: 200, retryAfterSeconds: 0 }),
  };
  const web = {
    sendPayload: jest.fn<WebPushClient['sendPayload']>().mockResolvedValue({ status: 201 }),
  };
  const logger = new LoggerService();
  const warn = jest.spyOn(logger, 'warn').mockImplementation((): void => {});
  const worker = new DialogPushWorker(
    events,
    dialogs as any,
    devices as any,
    apns as any,
    web as any,
    new ConfigService({ APNS_ENABLED: true }),
    logger,
  );
  const notice: DialogNotice = {
    users: ['sender', 'recipient'],
    event: {
      type: 'dialog.messages_available',
      payload: { dialog_id: 'dialog', last_sequence: 1 },
    },
    message: {
      message_id: 'message',
      dialog_id: 'dialog',
      sender_id: 'sender',
      client_message_id: 'client',
      sequence: 1,
      created_at: new Date(0).toISOString(),
      status: 'sent',
      content: { kind: 'text', text: 'private' },
    },
  };

  return { events, devices, dialogs, apns, web, worker, notice, warn };
}

describe('Best effort dialog push', (): void => {
  beforeEach((): void => {
    jest.useFakeTimers();
  });
  afterEach((): void => {
    jest.useRealTimers();
  });
  it('sends one ordinary alert to the recipient, invalidates only the attempted version and does not retry', async (): Promise<void> => {
    const f = fixture();

    f.apns.send.mockResolvedValue({
      status: 410,
      reason: 'Unregistered',
      timestamp: 123,
      retryAfterSeconds: 1,
    });
    f.events.publish(f.notice);
    await jest.advanceTimersByTimeAsync(0);
    expect(f.apns.send).toHaveBeenCalledTimes(1);
    expect(f.apns.send.mock.calls[0][2]).toEqual(
      expect.objectContaining({
        type: 'dialog.message',
        aps: { alert: { title: 'GChat', body: 'private' }, sound: 'default' },
      }),
    );
    expect(f.apns.send.mock.calls[0][4]).toBe('alert');
    expect(f.dialogs.canDeliver).toHaveBeenCalledWith('recipient', 'sid', 'device', 'dialog');
    expect(f.devices.invalidateApnsTarget).toHaveBeenCalledWith('device', 'v1', 123);
    await jest.advanceTimersByTimeAsync(60000);
    expect(f.apns.send).toHaveBeenCalledTimes(1);
    await f.worker.onModuleDestroy();
  });
  it('skips revoked destinations, stale addresses, and read receipts', async (): Promise<void> => {
    const f = fixture();

    f.dialogs.canDeliver.mockResolvedValue(false);
    f.events.publish(f.notice);
    await jest.advanceTimersByTimeAsync(0);
    expect(f.apns.send).not.toHaveBeenCalled();
    f.dialogs.canDeliver.mockResolvedValue(true);
    f.devices.resolveApnsTarget.mockResolvedValue({
      ...(await f.devices.resolveApnsTarget()),
      version: 'v2',
    });
    f.events.publish(f.notice);
    await jest.advanceTimersByTimeAsync(0);
    expect(f.apns.send).not.toHaveBeenCalled();
    f.events.publish({
      users: ['sender', 'recipient'],
      event: {
        type: 'dialog.read_updated',
        payload: { dialog_id: 'dialog', reader_id: 'recipient', last_read_sequence: 1 },
      },
    });
    await jest.advanceTimersByTimeAsync(0);
    expect(f.devices.listApnsTargets).toHaveBeenCalledTimes(2);
    await f.worker.onModuleDestroy();
  });
  it('bounds active messages at four, waiting jobs at 100 and includes queue delay in the ten-second deadline', async (): Promise<void> => {
    const f = fixture();

    f.apns.send.mockImplementation((): Promise<never> => new Promise((): void => {}));

    for (let i = 0; i < 105; i++) {
      f.events.publish(f.notice);
    }

    await jest.advanceTimersByTimeAsync(0);
    expect(f.apns.send).toHaveBeenCalledTimes(4);
    expect(f.warn).toHaveBeenCalledWith(
      'Dialog push skipped',
      expect.objectContaining({ reason: 'overload', count: 1 }),
    );
    await jest.advanceTimersByTimeAsync(10000);
    expect(f.apns.send).toHaveBeenCalledTimes(4);
    expect(f.warn).toHaveBeenCalledWith(
      'Dialog push skipped',
      expect.objectContaining({ reason: 'deadline' }),
    );
    await f.worker.onModuleDestroy();
    f.events.publish(f.notice);
    await jest.advanceTimersByTimeAsync(0);
    expect(f.apns.send).toHaveBeenCalledTimes(4);
  });
  it('bounds simultaneous address requests within one message at four', async (): Promise<void> => {
    const f = fixture();
    const target = (await f.devices.listApnsTargets())[0];

    f.devices.listApnsTargets.mockResolvedValue(Array.from({ length: 10 }, (): any => target));
    f.apns.send.mockImplementation((): Promise<never> => new Promise((): void => {}));
    f.events.publish(f.notice);
    await jest.advanceTimersByTimeAsync(0);
    expect(f.apns.send).toHaveBeenCalledTimes(4);
    await jest.advanceTimersByTimeAsync(10000);
    await f.worker.onModuleDestroy();
  });
});
