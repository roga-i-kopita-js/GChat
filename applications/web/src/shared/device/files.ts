import {
  type CallOptions,
  type CheckReport,
  CheckStatus,
  FileEvent,
  type FileEvents,
  type FilesService,
  type Page,
  type PageRequest,
  type ReadChunk,
  type Selection,
  type WriteSession,
} from './api';
import {
  type Args,
  type Command,
  type DeviceBridge,
  DeviceError,
  type FileRef,
  type Metadata,
  type Result,
} from './contract';
import { cancellable, Events } from './events';
import { type DeviceStorage, StorageArea } from './storage';

function encode(data: Uint8Array): string {
  let value = '';

  for (const byte of data) {
    value += String.fromCharCode(byte);
  }

  return btoa(value);
}
function decode(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (char): number => char.charCodeAt(0));
}

export class DeviceFiles extends Events<FileEvents> implements FilesService {
  private revision = 0;

  constructor(
    private readonly bridge: DeviceBridge,
    private readonly storage: DeviceStorage,
    private readonly signal: () => AbortSignal,
  ) {
    super();
  }

  private call<C extends Command>(
    command: C,
    args: Args<C>,
    options?: CallOptions,
  ): Promise<Result<C>> {
    return cancellable(
      (): Promise<Result<C>> => this.bridge.execute({ command, args }),
      options,
      this.signal(),
    );
  }

  private changed(ref: FileRef): void {
    this.emit(FileEvent.Changed, { revision: ++this.revision, ref });
  }

  private access(refs: FileRef[]): void {
    this.emit(FileEvent.AccessChanged, { revision: ++this.revision, refs });
  }

  async check(ref?: FileRef, options?: CallOptions): Promise<CheckReport> {
    if (ref) {
      try {
        await this.stat(ref, options);

        return { checks: [{ service: 'files', check: 'access', status: CheckStatus.Passed }] };
      } catch (error) {
        if (error instanceof DeviceError && error.code !== 'CANCELLED') {
          return {
            checks: [{ service: 'files', check: 'access', status: CheckStatus.Failed, error }],
          };
        }

        throw error;
      }
    }

    return {
      checks: [
        {
          service: 'files',
          check: 'provider',
          status: CheckStatus.NotChecked,
          reason: 'userConfirmationRequired',
        },
      ],
    };
  }

  async test(options?: CallOptions): Promise<CheckReport> {
    let created: Metadata | null = null;

    try {
      const root = await this.storage.getRoot(StorageArea.Temporary, options);

      created = await this.create(root, 'check-' + crypto.randomUUID(), options);
      const write = await this.beginWrite(
        created.ref,
        { mode: 'replace', expectedVersion: created.version },
        options,
      );
      const fixture = new Uint8Array([0, 255, 1, 128]);

      try {
        const { write: writeWrite } = write;

        await writeWrite.bind(write)(0, fixture, options);
        const { commit: writeCommit } = write;

        await writeCommit.bind(write)(options);
      } catch (cause) {
        const { abort: writeAbort } = write;

        await (async () => {
          try {
            return await writeAbort.bind(write)();
          } catch (cause) {}
        })();

        throw cause;
      }

      const read = await this.read(created.ref, { offset: 0, length: 4 }, options);

      const { eof: readEof, data: readData } = read ?? {};

      if (
        !readEof ||
        readData.length !== 4 ||
        !readData.every((value, index): boolean => value === fixture[index])
      ) {
        throw new DeviceError('IO_ERROR');
      }

      return { checks: [{ service: 'files', check: 'readWrite', status: CheckStatus.Passed }] };
    } catch (error) {
      if (
        !(error instanceof DeviceError) ||
        error.code === 'CANCELLED' ||
        error.code === 'INVALID_ARGUMENT'
      ) {
        throw error;
      }

      return error.code === 'UNSUPPORTED'
        ? {
            checks: [
              {
                service: 'files',
                check: 'readWrite',
                status: CheckStatus.NotChecked,
                reason: 'unsupported',
              },
            ],
          }
        : { checks: [{ service: 'files', check: 'readWrite', status: CheckStatus.Failed, error }] };
    } finally {
      if (created) {
        await (async () => {
          try {
            return await this.remove(created.ref, { recursive: false });
          } catch (cause) {}
        })();
      }
    }
  }

  async pick(
    selection: { multiple: boolean; accept: string[] },
    options?: CallOptions,
  ): Promise<Selection<Metadata[]>> {
    const result = await this.call('file.pick', selection, options);

    const { outcome: resultOutcome } = result;

    if (resultOutcome === 'cancelled') {
      return { outcome: 'cancelled' };
    }

    const { entries: resultEntries } = result;

    this.access(resultEntries.map((value): FileRef => value.ref));

    const { entries: resultEntries2 } = result;

    return { outcome: 'completed', value: resultEntries2 };
  }

  async pickDirectory(options?: CallOptions): Promise<Selection<Metadata>> {
    const result = await this.call('directory.pick', {}, options);

    const { outcome: resultOutcome2 } = result;

    if (resultOutcome2 === 'cancelled') {
      return { outcome: 'cancelled' };
    }

    const { entry: resultEntry } = result ?? {};

    if (!resultEntry) {
      throw new DeviceError('INTEGRATION_ERROR');
    }

    this.access([resultEntry.ref]);

    return { outcome: 'completed', value: resultEntry };
  }

  listAccesses(page: PageRequest, options?: CallOptions): Promise<Page<FileRef>> {
    return this.call('file.access.list', page, options);
  }

  async restoreAccess(ref: FileRef, options?: CallOptions): Promise<Metadata> {
    try {
      const value = await this.call('file.access.restore', { id: ref.id }, options);

      const { ref: valueRef } = value;

      this.access([valueRef]);

      return value;
    } catch (cause) {
      if (
        cause instanceof DeviceError &&
        ['ACCESS_LOST', 'NOT_FOUND', 'PERMISSION_DENIED'].includes(cause.code)
      ) {
        this.access([ref]);
      }

      throw cause;
    }
  }

  async forgetAccess(ref: FileRef, options?: CallOptions): Promise<void> {
    await this.call('file.access.forget', { id: ref.id }, options);
    this.access([ref]);
  }

  stat(ref: FileRef, options?: CallOptions): Promise<Metadata> {
    return this.call('file.stat', { id: ref.id }, options);
  }

  list(directory: FileRef, page: PageRequest, options?: CallOptions): Promise<Page<Metadata>> {
    return this.call('directory.list', { directoryId: directory.id, ...page }, options);
  }

  async read(
    file: FileRef,
    range: { offset: number; length: number },
    options?: CallOptions,
  ): Promise<ReadChunk> {
    const {
      dataBase64: valueDataBase64,
      bytesRead: valueBytesRead,
      eof: valueEof,
      version: valueVersion,
    } = await this.call('file.read', { fileId: file.id, ...range }, options);

    return {
      data: decode(valueDataBase64),
      bytesRead: valueBytesRead,
      eof: valueEof,
      version: valueVersion,
    };
  }

  async create(directory: FileRef, name: string, options?: CallOptions): Promise<Metadata> {
    const value = await this.call('file.create', { directoryId: directory.id, name }, options);

    const { ref: valueRef2 } = value;

    this.changed(valueRef2);

    return value;
  }

  async createDirectory(
    directory: FileRef,
    name: string,
    options?: CallOptions,
  ): Promise<Metadata> {
    const value = await this.call('directory.create', { directoryId: directory.id, name }, options);

    const { ref: valueRef3 } = value;

    this.changed(valueRef3);

    return value;
  }

  async beginWrite(
    file: FileRef,
    write: { mode: 'replace' | 'update'; expectedVersion: string | null },
    options?: CallOptions,
  ): Promise<WriteSession> {
    const { writeId } = await this.call('file.write.begin', { fileId: file.id, ...write }, options);
    const context = this.signal();
    let busy = false;
    let finished = false;
    let saved: Metadata | undefined;
    const run = async <T>(operation: () => Promise<T>, callOptions?: CallOptions): Promise<T> => {
      if (context.aborted) {
        throw new DeviceError('CANCELLED');
      }

      if (busy) {
        throw new DeviceError('BUSY');
      }

      if (callOptions?.signal?.aborted) {
        throw new DeviceError('CANCELLED');
      }

      busy = true;
      let pending: Promise<T>;

      try {
        pending = operation();
      } catch (cause) {
        busy = false;

        throw cause;
      }

      void (async () => {
        try {
          await pending;
        } catch (rejectedCause) {
          busy = false;

          return;
        }

        busy = false;
      })();

      return cancellable((): Promise<T> => pending, callOptions, context);
    };

    return {
      write: (offset, data, callOptions): Promise<{ bytesWritten: number }> =>
        run(async (): Promise<{ bytesWritten: number }> => {
          if (finished) {
            throw new DeviceError('INVALID_STATE');
          }

          if (!(data instanceof Uint8Array) || data.byteLength > 262144) {
            throw new DeviceError('INVALID_ARGUMENT');
          }

          return this.bridge.execute({
            command: 'file.write.chunk',
            args: { writeId, offset, dataBase64: encode(data) },
          });
        }, callOptions),
      commit: (callOptions): Promise<Metadata> =>
        run(async (): Promise<Metadata> => {
          if (saved) {
            return saved;
          }

          if (finished) {
            throw new DeviceError('INVALID_STATE');
          }

          // Terminal even if the reply is lost. Retrying an unknown commit is forbidden.
          finished = true;
          saved = await this.bridge.execute({ command: 'file.write.commit', args: { writeId } });

          if (!context.aborted) {
            this.changed(saved.ref);
          }

          return saved;
        }, callOptions),
      abort: async (): Promise<void> => {
        if (busy) {
          throw new DeviceError('BUSY');
        }

        if (finished) {
          return;
        }

        await run(async (): Promise<void> => {
          finished = true;
          await this.bridge.execute({ command: 'file.write.abort', args: { writeId } });
        });
      },
    };
  }

  async copy(
    ref: FileRef,
    destination: { directory: FileRef; name: string },
    options?: CallOptions,
  ): Promise<Metadata> {
    const value = await this.call(
      'file.copy',
      { id: ref.id, destinationDirectoryId: destination.directory.id, name: destination.name },
      options,
    );

    const { ref: valueRef4 } = value;

    this.changed(valueRef4);

    return value;
  }

  async move(
    ref: FileRef,
    destination: { directory: FileRef; name: string },
    options?: CallOptions,
  ): Promise<Metadata> {
    const value = await this.call(
      'file.move',
      { id: ref.id, destinationDirectoryId: destination.directory.id, name: destination.name },
      options,
    );

    const { ref: valueRef5 } = value;

    this.changed(valueRef5);

    return value;
  }

  async rename(ref: FileRef, name: string, options?: CallOptions): Promise<Metadata> {
    const value = await this.call('file.rename', { id: ref.id, name }, options);

    const { ref: valueRef6 } = value;

    this.changed(valueRef6);

    return value;
  }

  async remove(ref: FileRef, remove: { recursive: boolean }, options?: CallOptions): Promise<void> {
    await this.call('file.remove', { id: ref.id, ...remove }, options);
    this.changed(ref);
  }

  async saveAs(
    file: FileRef,
    suggestedName: string,
    options?: CallOptions,
  ): Promise<Selection<Metadata>> {
    const value = await this.call('file.saveAs', { sourceFileId: file.id, suggestedName }, options);

    const { outcome: valueOutcome } = value;

    if (valueOutcome === 'cancelled') {
      return { outcome: 'cancelled' };
    }

    const { entry: valueEntry } = value ?? {};

    if (!valueEntry) {
      throw new DeviceError('INTEGRATION_ERROR');
    }

    this.changed(valueEntry.ref);

    this.access([valueEntry.ref]);

    return { outcome: 'completed', value: valueEntry };
  }

  async export(
    file: FileRef,
    suggestedName: string,
    options?: CallOptions,
  ): Promise<Selection<void>> {
    const value = await this.call('file.export', { sourceFileId: file.id, suggestedName }, options);

    const { outcome: valueOutcome2 } = value;

    return valueOutcome2 === 'cancelled'
      ? { outcome: 'cancelled' }
      : { outcome: 'completed', value: undefined };
  }
}
