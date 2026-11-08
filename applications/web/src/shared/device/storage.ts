import type { DeviceBridge, FileRef } from './contract';
import { cancellable } from './events';

export enum StorageArea {
  Data = 'data',
  Temporary = 'temporary',
  Cache = 'cache',
}

export interface CallOptions {
  signal?: AbortSignal;
}

export class DeviceStorage {
  constructor(
    private readonly bridge: DeviceBridge,
    private readonly signal?: () => AbortSignal,
  ) {}

  getRoot(area: StorageArea, options: CallOptions = {}): Promise<FileRef> {
    return this.run(
      (): Promise<FileRef> => this.bridge.execute({ command: 'storage.getRoot', args: { area } }),
      options,
    );
  }

  getUsage(
    area: StorageArea,
    options: CallOptions = {},
  ): Promise<{ usedBytes: number | null; quotaBytes: number | null }> {
    return this.run(
      (): Promise<{ usedBytes: number | null; quotaBytes: number | null }> =>
        this.bridge.execute({ command: 'storage.getUsage', args: { area } }),
      options,
    );
  }

  private run<T>(operation: () => Promise<T>, options: CallOptions): Promise<T> {
    return cancellable(operation, options, this.signal?.());
  }
}
