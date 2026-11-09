import { DeviceError } from './contract';

export type StorageAreaName = 'data' | 'temporary' | 'cache';

function directoryHandle(value: FileSystemHandle): value is FileSystemDirectoryHandle {
  return 'getDirectoryHandle' in value;
}
function fileHandle(value: FileSystemHandle): value is FileSystemFileHandle {
  return 'getFile' in value;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** OPFS namespaces with one Web Lock per temporary owner. No origin-wide cleanup. */
export class BrowserStorage {
  private started?: Promise<void>;
  private base?: FileSystemDirectoryHandle;
  private temporary?: FileSystemDirectoryHandle;
  private release?: () => void;
  private readonly owner = crypto.randomUUID();
  private stopped = false;

  start(): Promise<void> {
    if (this.stopped) {
      return Promise.reject(new DeviceError('INVALID_STATE'));
    }

    this.started ??= this.initialize();

    return this.started;
  }

  private async initialize(): Promise<void> {
    if (!navigator.storage?.getDirectory || !navigator.locks) {
      throw new DeviceError('UNSUPPORTED');
    }

    const root = await navigator.storage.getDirectory();

    const { getDirectoryHandle: rootGetDirectoryHandle } = root;

    this.base = await rootGetDirectoryHandle.bind(root)('gchat-device-storage-v1', {
      create: true,
    });
    const owners = await this.base.getDirectoryHandle('temporary', { create: true });

    await new Promise<void>((resolve, reject): void => {
      void (async () => {
        try {
          return await navigator.locks.request(
            `gchat-storage-owner-${this.owner}`,
            async (): Promise<void> => {
              await new Promise<void>((release): void => {
                this.release = release;
                resolve();
              });
            },
          );
        } catch (cause) {
          return reject(cause);
        }
      })();
    });

    try {
      await navigator.locks.request('gchat-storage-namespace-v1', async (): Promise<void> => {
        const { values: ownersValues } = owners;

        for await (const entry of ownersValues.bind(owners)()) {
          if (entry.kind !== 'directory' || !uuid.test(entry.name) || entry.name === this.owner) {
            continue;
          }

          await navigator.locks.request(
            `gchat-storage-owner-${entry.name}`,
            { ifAvailable: true },
            async (lock): Promise<void> => {
              if (lock) {
                const { removeEntry: ownersRemoveEntry } = owners;

                await ownersRemoveEntry.bind(owners)(entry.name, { recursive: true });
              }
            },
          );
        }

        const { getDirectoryHandle: ownersGetDirectoryHandle } = owners;

        this.temporary = await ownersGetDirectoryHandle.bind(owners)(this.owner, { create: true });
      });
    } catch (error) {
      this.release?.();

      throw error;
    }

    if (this.stopped) {
      await this.cleanup();

      throw new DeviceError('CANCELLED');
    }
  }

  async root(area: StorageAreaName): Promise<FileSystemDirectoryHandle> {
    await this.start();

    if (area === 'temporary') {
      return this.temporary!;
    }

    return this.base!.getDirectoryHandle(area, { create: true });
  }

  async usage(area: StorageAreaName): Promise<{ usedBytes: number; quotaBytes: null }> {
    const count = async (directory: FileSystemDirectoryHandle): Promise<number> => {
      let size = 0;

      for await (const handle of directory.values()) {
        if (directoryHandle(handle)) {
          size += await count(handle);
        } else if (fileHandle(handle)) {
          const { size: getFileResultSize } = await handle.getFile();

          size += getFileResultSize;
        } else {
          throw new DeviceError('WRONG_TYPE');
        }

        if (!Number.isSafeInteger(size)) {
          throw new DeviceError('IO_ERROR');
        }
      }

      return size;
    };

    const usedBytesValue = await count(await this.root(area));

    return { usedBytes: usedBytesValue, quotaBytes: null };
  }

  async resolve(
    area: StorageAreaName,
    components: string[],
    kind: 'file' | 'directory',
  ): Promise<FileSystemHandle> {
    let directory = await this.root(area);

    for (let i = 0; i < components.length; i++) {
      const name = components[i];

      if (!name || name === '.' || name === '..' || /[\/\\\0]/.test(name)) {
        throw new DeviceError('INVALID_ARGUMENT');
      }

      if (i === components.length - 1 && kind === 'file') {
        return directory.getFileHandle(name);
      }

      directory = await directory.getDirectoryHandle(name);
    }

    return directory;
  }

  private async cleanup(): Promise<void> {
    try {
      if (this.base) {
        const resolved = await this.base.getDirectoryHandle('temporary');
        const { removeEntry: getDirectoryHandleResultRemoveEntry } = resolved;

        await getDirectoryHandleResultRemoveEntry.bind(resolved)(this.owner, { recursive: true });
      }
    } finally {
      this.release?.();
      this.release = undefined;
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }

    this.stopped = true;

    try {
      await this.started;
    } catch {
      /* Failed initialization has no live namespace. */
    }

    await this.cleanup();
  }
}
