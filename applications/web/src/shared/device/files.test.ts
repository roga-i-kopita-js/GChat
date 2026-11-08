import { describe, expect, it, vi } from 'vitest';

import {
  type Args,
  type Command,
  type DeviceBridge,
  DeviceError,
  type FileRef,
  type Metadata,
  type Result,
} from './contract';
import { DeviceFiles } from './files';
import { DeviceStorage } from './storage';

const ref: FileRef = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'file',
  kind: 'file',
  persistence: 'persistent',
};
const saved: Metadata = { ref, size: 3, modifiedAt: null, mimeType: null, version: 'next' };

class Bridge implements DeviceBridge {
  chunk = vi.fn<() => Promise<{ bytesWritten: number }>>().mockResolvedValue({ bytesWritten: 3 });
  commit = vi.fn<() => Promise<Metadata>>().mockResolvedValue(saved);
  abort = vi
    .fn<() => Promise<{ outcome: 'completed' }>>()
    .mockResolvedValue({ outcome: 'completed' });

  async execute<C extends Command>(request: { command: C; args: Args<C> }): Promise<Result<C>> {
    if (request.command === 'file.write.begin') {
      return { writeId: '00000000-0000-4000-8000-000000000002' } as Result<C>;
    }

    if (request.command === 'file.write.chunk') {
      return (await this.chunk()) as Result<C>;
    }

    if (request.command === 'file.write.commit') {
      return (await this.commit()) as Result<C>;
    }

    if (request.command === 'file.write.abort') {
      return (await this.abort()) as Result<C>;
    }

    throw new Error(request.command);
  }
}

function fixture(): { bridge: Bridge; controller: AbortController; files: DeviceFiles } {
  const bridge = new Bridge();
  const controller = new AbortController();

  return {
    bridge,
    controller,
    files: new DeviceFiles(bridge, new DeviceStorage(bridge), (): AbortSignal => controller.signal),
  };
}

describe('public file write sessions', (): void => {
  it('keeps serialization until the platform reply even when the caller stops waiting', async (): Promise<void> => {
    const { bridge, files } = fixture();
    let resolve!: (value: { bytesWritten: number }) => void;

    bridge.chunk.mockImplementation(
      (): Promise<{ bytesWritten: number }> =>
        new Promise((done): void => {
          resolve = done;
        }),
    );
    const write = await files.beginWrite(ref, { mode: 'replace', expectedVersion: null });
    const caller = new AbortController();
    const pending = write.write(0, new Uint8Array([1, 2, 3]), { signal: caller.signal });

    caller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    await expect(write.commit()).rejects.toMatchObject({ code: 'BUSY' });
    resolve({ bytesWritten: 3 });
    await new Promise<void>((done): void => {
      setTimeout(done, 0);
    });
    expect(await write.commit()).toEqual(saved);
    expect(bridge.chunk).toHaveBeenCalledTimes(1);
  });
  it('never retries an unknown commit but caches a confirmed one', async (): Promise<void> => {
    const { bridge, files } = fixture();

    bridge.commit.mockRejectedValueOnce(new DeviceError('OUTCOME_UNKNOWN'));
    const unknown = await files.beginWrite(ref, { mode: 'replace', expectedVersion: null });

    await expect(unknown.commit()).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    await expect(unknown.commit()).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(bridge.commit).toHaveBeenCalledTimes(1);
    const known = await files.beginWrite(ref, { mode: 'replace', expectedVersion: null });

    expect(await known.commit()).toBe(saved);
    expect(await known.commit()).toBe(saved);
    await known.abort();
    expect(bridge.commit).toHaveBeenCalledTimes(2);
    expect(bridge.abort).not.toHaveBeenCalled();
  });
  it('cancels old write contexts and makes abort idempotent', async (): Promise<void> => {
    const { bridge, files, controller } = fixture();
    const write = await files.beginWrite(ref, { mode: 'replace', expectedVersion: null });

    await write.abort();
    await write.abort();
    expect(bridge.abort).toHaveBeenCalledTimes(1);
    const old = await files.beginWrite(ref, { mode: 'replace', expectedVersion: null });

    controller.abort();
    await expect(old.write(0, new Uint8Array([1]))).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(bridge.chunk).not.toHaveBeenCalled();
  });
});
