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
      await (async () => {
        try {
          return await this.files.remove(file.ref, { recursive: false });
        } catch (cause) {}
      })();

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
          const { bytesWritten: resultBytesWritten } = await writer.write(offset, bytes);

          if (resultBytesWritten !== bytes.byteLength) {
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
        await (async () => {
          try {
            return await writer.abort();
          } catch (cause) {}
        })();

        if (file) {
          await (async () => {
            try {
              return await this.files.remove(file.ref, { recursive: false });
            } catch (cause) {}
          })();
        }

        file = null;
      },
    };
  }

  async photo(blob: Blob): Promise<FileRef> {
    const write = await this.begin('jpg', 'image/jpeg');

    try {
      const { write: writeWrite } = write;

      await writeWrite.bind(write)(blob);

      const { commit: writeCommit } = write;

      return await writeCommit.bind(write)();
    } catch (cause) {
      const { abort: writeAbort } = write;

      await writeAbort.bind(write)();

      throw cause;
    }
  }
}
