import { describe, expect, it, vi } from 'vitest';

import { DeviceChanges } from './changes';
import { argsSchemas, resultsSchemas } from './contract';

describe('device command boundary', (): void => {
  it('rejects traversal, boolean numbers, extra fields and oversized chunks', (): void => {
    expect(
      argsSchemas['file.create'].safeParse({ directoryId: crypto.randomUUID(), name: '../secret' })
        .success,
    ).toBe(false);
    expect(
      argsSchemas['file.read'].safeParse({ fileId: crypto.randomUUID(), offset: false, length: 10 })
        .success,
    ).toBe(false);
    expect(
      argsSchemas['permission.request'].safeParse({
        resource: 'camera',
        url: 'https://other.invalid',
      }).success,
    ).toBe(false);
    expect(
      argsSchemas['file.write.chunk'].safeParse({
        writeId: crypto.randomUUID(),
        offset: 0,
        dataBase64: 'A'.repeat(349532),
      }).success,
    ).toBe(false);
  });
  it('requires a complete, normalized reply and keeps limited notification permission', (): void => {
    expect(
      resultsSchemas['push.enable'].parse({
        outcome: 'completed',
        push: {
          permission: 'limited',
          alert: 'disabled',
          sound: 'unknown',
          badge: 'enabled',
          delivery: 'unavailable',
        },
      }).push.permission,
    ).toBe('limited');
    expect(resultsSchemas['permission.read'].safeParse({ permission: 'authorized' }).success).toBe(
      false,
    );
  });
});

describe('device revision waits', (): void => {
  it('does not lose a change between read and wait, or consume it for the next reader', async (): Promise<void> => {
    const changes = new DeviceChanges();
    const read = changes.revision;

    changes.touch('camera');
    expect(await changes.wait(read, 1000)).toEqual({
      revision: 1,
      changed: ['camera'],
      timedOut: false,
    });
    const { changed: waitResultChanged } = await changes.wait(read, 1000);

    expect(waitResultChanged).toEqual(['camera']);
  });
  it('rejects parallel waits, cancels exactly the pending waiter, then accepts a new one', async (): Promise<void> => {
    const changes = new DeviceChanges();
    const pending = changes.wait(0, 1000);

    await expect(changes.wait(0, 1000)).rejects.toMatchObject({ code: 'BUSY' });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });

    changes.cancel();
    await rejected;
    const next = changes.wait(0, 1000);

    changes.touch('audio');
    const { changed: resultChanged } = await next;

    expect(resultChanged).toEqual(['audio']);
  });
  it('times out without polling or fabricating a revision', async (): Promise<void> => {
    vi.useFakeTimers();
    const changes = new DeviceChanges();
    const pending = changes.wait(0, 1000);

    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toEqual({ revision: 0, changed: [], timedOut: true });
    await expect(changes.wait(2, 1000)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    vi.useRealTimers();
  });
});
