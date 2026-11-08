import { describe, expect, it, vi } from 'vitest';

import type { DeviceBridge, FileRef } from './contract';
import { DeviceStorage, StorageArea } from './storage';

describe('StorageService facade', (): void => {
  it('uses typed commands and preserves references and unknown quotas', async (): Promise<void> => {
    const root: FileRef = {
      id: crypto.randomUUID(),
      name: 'data',
      kind: 'directory',
      persistence: 'persistent',
    };
    const execute = vi
      .fn()
      .mockResolvedValueOnce(root)
      .mockResolvedValueOnce({ usedBytes: 3, quotaBytes: null });
    const storage = new DeviceStorage({ execute } as DeviceBridge);

    expect(await storage.getRoot(StorageArea.Data)).toEqual(root);
    expect(await storage.getUsage(StorageArea.Data)).toEqual({ usedBytes: 3, quotaBytes: null });
    expect(execute.mock.calls).toEqual([
      [{ command: 'storage.getRoot', args: { area: 'data' } }],
      [{ command: 'storage.getUsage', args: { area: 'data' } }],
    ]);
  });
  it('does not begin preaborted operations and drops late results after cancellation', async (): Promise<void> => {
    let complete!: (value: unknown) => void;
    const execute = vi.fn(
      (): Promise<unknown> =>
        new Promise((resolve): void => {
          complete = resolve;
        }),
    );
    const storage = new DeviceStorage({ execute } as DeviceBridge);

    await expect(
      storage.getRoot(StorageArea.Cache, { signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(execute).not.toHaveBeenCalled();
    const controller = new AbortController();
    const result = storage.getUsage(StorageArea.Cache, { signal: controller.signal });

    controller.abort();
    await expect(result).rejects.toMatchObject({ code: 'CANCELLED' });
    complete({ usedBytes: 0, quotaBytes: null });
  });
});
