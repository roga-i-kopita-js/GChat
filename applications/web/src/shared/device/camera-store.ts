import { type FilesService, StorageArea, type StorageService, type WriteSession } from './api';
import type { FileRef, Metadata } from './contract';
import { DeviceError } from './contract';

/** Recording data stays in the provider's staged write, then moves to Data before publication. */
export class CameraStore {
  constructor(
    private readonly files: FilesService,
    private readonly storage: StorageService,
    private readonly mime: (ref: FileRef, type: string) => Promise<void>,
  ) {}

  async begin(
    extension: string,
    type: string,
  ): Promise<{
    write(chunk: Blob): Promise<void>;
    commit(): Promise<FileRef>;
    abort(): Promise<void>;
  }> {
    const temporary = await this.storage.getRoot(StorageArea.Temporary);
    const data = await this.storage.getRoot(StorageArea.Data);
    const name = 'camera-' + crypto.randomUUID() + '.' + extension;
    let file: Metadata | null = await this.files.create(temporary, name);
    let writer: WriteSession;

    try {
      writer = await this.files.beginWrite(file.ref, {
        mode: 'replace',
        expectedVersion: file.version,
      });
    } catch (cause) {
      await this.files.remove(file.ref, { recursive: false }).catch((): void => {});

      throw cause;
    }

    let offset = 0;
    let done = false;

    return {
      write: async (chunk): Promise<void> => {
        if (done) {
          throw new DeviceError('INVALID_STATE');
        }

        for (let index = 0; index < chunk.size; index += 262144) {
          const bytes = new Uint8Array(await chunk.slice(index, index + 262144).arrayBuffer());
          const result = await writer.write(offset, bytes);

          if (result.bytesWritten !== bytes.byteLength) {
            throw new DeviceError('IO_ERROR');
          }

          offset += bytes.byteLength;
        }
      },
      commit: async (): Promise<FileRef> => {
        if (done || !file) {
          throw new DeviceError('INVALID_STATE');
        }

        file = await writer.commit();
        file = await this.files.move(file.ref, { directory: data, name });

        if (file.ref.persistence !== 'persistent') {
          throw new DeviceError('IO_ERROR');
        }

        await this.mime(file.ref, type);
        done = true;

        return file.ref;
      },
      abort: async (): Promise<void> => {
        if (done) {
          return;
        }

        done = true;
        await writer.abort().catch((): void => {});

        if (file) {
          await this.files.remove(file.ref, { recursive: false }).catch((): void => {});
        }

        file = null;
      },
    };
  }

  async photo(blob: Blob): Promise<FileRef> {
    const write = await this.begin('jpg', 'image/jpeg');

    try {
      await write.write(blob);

      return await write.commit();
    } catch (cause) {
      await write.abort();

      throw cause;
    }
  }
}
