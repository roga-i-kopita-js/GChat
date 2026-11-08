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
  expect(Object.isFrozen(initial.settings)).toBe(true);
  const received = vi.fn();

  service.on(NotificationEvent.IntentReceived, received);
  const intent = { id: 'intent', kind: 'dialog', dialogId: 'dialog' };

  service.receive({ id: intent.id, kind: 'dialog', dialogId: intent.dialogId });
  service.receive({ id: intent.id, kind: 'dialog', dialogId: intent.dialogId });
  const next = await service.getState();

  expect(next.revision).toBeGreaterThan(initial.revision);
  expect(initial.pendingIntent).toBeNull();
  expect(Object.isFrozen(next.pendingIntent)).toBe(true);
  expect(received).toHaveBeenCalledTimes(1);
  service.stop();
});
