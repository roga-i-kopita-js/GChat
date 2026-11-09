import { expect, it, vi } from 'vitest';

import { NotificationEvent } from './api';
import type { DeviceBridge } from './contract';
import { DeviceNotifications } from './notifications';
import { DeviceObserver } from './observer';

it('keeps initial notification snapshots immutable and deduplicates pending intents', async (): Promise<void> => {
  const bridge: DeviceBridge = {
    execute: async (): Promise<never> => {
      throw new Error('Unexpected platform command');
    },
  };
  const service = new DeviceNotifications(
    bridge,
    new DeviceObserver(bridge),
    (): AbortSignal => new AbortController().signal,
  );
  const initial = await service.getState();

  expect(Object.isFrozen(initial)).toBe(true);
  const { settings: initialSettings } = initial;

  expect(Object.isFrozen(initialSettings)).toBe(true);
  const received = vi.fn();

  service.on(NotificationEvent.IntentReceived, received);
  const intent = { id: 'intent', kind: 'dialog', dialogId: 'dialog' };

  service.receive({ id: intent.id, kind: 'dialog', dialogId: intent.dialogId });
  service.receive({ id: intent.id, kind: 'dialog', dialogId: intent.dialogId });
  const next = await service.getState();

  const { revision: nextRevision } = next;
  const { revision: initialRevision } = initial;

  expect(nextRevision).toBeGreaterThan(initialRevision);
  const { pendingIntent: initialPendingIntent } = initial;

  expect(initialPendingIntent).toBeNull();
  const { pendingIntent: nextPendingIntent } = next;

  expect(Object.isFrozen(nextPendingIntent)).toBe(true);
  expect(received).toHaveBeenCalledTimes(1);
  service.stop();
});
