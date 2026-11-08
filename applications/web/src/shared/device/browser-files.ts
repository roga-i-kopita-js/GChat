import { z } from 'zod';

import { BrowserStorage, type StorageAreaName } from './browser-storage';
import { argsSchemas, DeviceError, type FileRef, type Metadata } from './contract';

declare global {
  interface Window {
    showOpenFilePicker?: (options: {
      multiple: boolean;
      types?: { accept: Record<string, string[]> }[];
    }) => Promise<FileSystemFileHandle[]>;
    showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle>;
    showSaveFilePicker?: (options: { suggestedName: string }) => Promise<FileSystemFileHandle>;
  }
  interface FileSystemDirectoryHandle {
    values(): AsyncIterableIterator<FileSystemHandle>;
  }
  interface FileSystemHandle {
    queryPermission?: (options: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>;
    requestPermission?: (options: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>;
    move?: (destination: FileSystemDirectoryHandle, name: string) => Promise<void>;
  }
}
interface Entry {
  captureMime?: string;
  internal?: { area: StorageAreaName; components: string[] };
  ref: FileRef;
  handle?: FileSystemHandle;
  file?: File;
  parent?: string;
  root: string;
}
interface Write {
  entry: Entry;
  writer: FileSystemWritableFileStream;
  temp: FileSystemFileHandle;
  tempName: string;
  size: number;
  expected: string | null;
  release(): void;
}
function isHandle(value: unknown): value is FileSystemHandle {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    'name' in value &&
    'isSameEntry' in value
  );
}
function isFile(handle: FileSystemHandle): handle is FileSystemFileHandle {
  return 'getFile' in handle;
}
function isDirectory(handle: FileSystemHandle): handle is FileSystemDirectoryHandle {
  return 'getDirectoryHandle' in handle;
}
const internalStored = z.strictObject({
  captureMime: z.string().optional(),
  id: z.uuid(),
  ref: z.object({ name: z.string(), kind: z.enum(['file', 'directory']) }),
  internal: z.strictObject({ area: z.enum(['data', 'cache']), components: z.array(z.string()) }),
});
const stored = z.object({ id: z.uuid(), handle: z.custom<FileSystemHandle>(isHandle) });

export class BrowserFiles {
  private storage = new BrowserStorage();
  private entries = new Map<string, Entry>();
  private writes = new Map<string, Write>();
  private loading?: Promise<void>;
  private database?: IDBDatabase;
  private epoch = 0;
  private revision = 0;
  private dialog = false;
  private cancelInput?: () => void;

  constructor(private readonly changed: () => void) {}

  private async db(): Promise<IDBDatabase> {
    if (this.database) {
      return this.database;
    }

    const db = await new Promise<IDBDatabase>((resolve, reject): void => {
      const request = indexedDB.open('gchat-device-files', 1);

      request.onupgradeneeded = (): void => {
        request.result.createObjectStore('grants', { keyPath: 'id' });
      };
      request.onsuccess = (): void => resolve(request.result);
      request.onerror = (): void => reject(new DeviceError('IO_ERROR'));
    });

    this.database = db;

    return db;
  }

  private async transaction(action: (store: IDBObjectStore) => void): Promise<void> {
    const db = await this.db();

    await new Promise<void>((resolve, reject): void => {
      const tx = db.transaction('grants', 'readwrite');

      action(tx.objectStore('grants'));
      tx.oncomplete = (): void => resolve();
      tx.onerror = tx.onabort = (): void => reject(new DeviceError('IO_ERROR'));
    });
  }

  async load(): Promise<void> {
    this.loading ??= (async (): Promise<void> => {
      try {
        const db = await this.db();
        const values = await new Promise<unknown[]>((resolve, reject): void => {
          const request = db.transaction('grants').objectStore('grants').getAll();

          request.onsuccess = (): void => resolve(request.result);
          request.onerror = (): void => reject(new DeviceError('IO_ERROR'));
        });

        for (const value of values) {
          const internal = internalStored.safeParse(value);

          if (internal.success) {
            const { id, ref, internal: path } = internal.data;

            try {
              const handle = await this.storage.resolve(path.area, path.components, ref.kind);

              this.entries.set(id, {
                ref: { id, ...ref, persistence: 'persistent' },
                handle,
                root: id,
                internal: path,
                captureMime: internal.data.captureMime,
              });
            } catch {
              /* Missing internal files are not restored as usable handles. */
            }

            continue;
          }

          const item = stored.safeParse(value);

          if (item.success) {
            const { id, handle } = item.data;

            this.entries.set(id, {
              ref: { id, name: handle.name, kind: handle.kind, persistence: 'persistent' },
              handle,
              root: id,
            });
          }
        }

        for (const entry of this.entries.values()) {
          if (!entry.internal) {
            continue;
          }

          const path = entry.internal;
          const parent = [...this.entries.values()].find(
            (candidate): boolean =>
              candidate.internal?.area === path.area &&
              JSON.stringify(candidate.internal.components) ===
                JSON.stringify(path.components.slice(0, -1)),
          );
          const root = [...this.entries.values()].find(
            (candidate): boolean =>
              candidate.internal?.area === path.area && candidate.internal.components.length === 0,
          );

          entry.parent = path.components.length ? parent?.ref.id : undefined;
          entry.root = root?.ref.id ?? entry.ref.id;
        }
      } catch {
        /* Private browsing can still provide session-only files. */
      }

      if (typeof navigator !== 'undefined' && navigator.storage?.getDirectory && navigator.locks) {
        try {
          const root = await navigator.storage.getDirectory();

          for await (const entry of root.values()) {
            if (!/^gchat-write-[0-9a-f-]{36}$/.test(entry.name)) {
              continue;
            }

            const id = entry.name.slice('gchat-write-'.length);

            await navigator.locks.request(
              `gchat-device-write-${id}`,
              { ifAvailable: true },
              async (lock): Promise<void> => {
                if (lock) {
                  await root.removeEntry(entry.name).catch((): void => {});
                }
              },
            );
          }
        } catch {
          /* OPFS is optional for read-only file selection. */
        }
      }
    })();
    await this.loading;
  }

  async count(): Promise<number> {
    await this.load();

    return [...this.entries.values()].filter(
      (entry): boolean => !entry.internal && entry.root === entry.ref.id,
    ).length;
  }

  private touch(): void {
    this.revision++;
    this.changed();
  }

  private async retain(handle: FileSystemHandle, parent?: string): Promise<Entry> {
    await this.load();

    for (const entry of this.entries.values()) {
      if (entry.handle && (await entry.handle.isSameEntry(handle).catch((): boolean => false))) {
        entry.handle = handle;

        await this.persist(entry);

        return entry;
      }
    }

    const id = crypto.randomUUID();
    const root = parent ? this.entry(parent).root : id;
    const owner = parent ? this.entry(parent).internal : undefined;
    const entry: Entry = {
      ref: { id, name: handle.name, kind: handle.kind, persistence: 'session' },
      handle,
      parent,
      root,
      ...(owner
        ? { internal: { area: owner.area, components: [...owner.components, handle.name] } }
        : {}),
    };

    if (entry.internal) {
      entry.ref.persistence = entry.internal.area === 'temporary' ? 'session' : 'persistent';
      await this.persist(entry);
    } else if (!parent) {
      try {
        await this.transaction((store): void => {
          store.put({ id, handle });
        });
        entry.ref.persistence = 'persistent';
      } catch {
        /* The handle remains usable during this document. */
      }
    }

    this.entries.set(id, entry);
    this.touch();

    return entry;
  }

  private async persist(entry: Entry): Promise<void> {
    if (entry.internal) {
      if (entry.internal.area === 'temporary') {
        await this.transaction((store): void => {
          store.delete(entry.ref.id);
        });
      } else {
        await this.transaction((store): void => {
          store.put({
            id: entry.ref.id,
            ref: { name: entry.ref.name, kind: entry.ref.kind },
            internal: entry.internal,
            ...(entry.captureMime ? { captureMime: entry.captureMime } : {}),
          });
        });
      }
    } else if (entry.ref.persistence === 'persistent') {
      await this.transaction((store): void => {
        store.put({ id: entry.ref.id, handle: entry.handle });
      });
    }
  }

  private entry(id: string): Entry {
    const entry = this.entries.get(id);

    if (!entry) {
      throw new DeviceError('NOT_FOUND');
    }

    return entry;
  }

  private async authorize(entry: Entry, mode: 'read' | 'readwrite', prompt = false): Promise<void> {
    const handle = entry.handle;

    if (!handle?.queryPermission) {
      return;
    }

    let permission = await handle.queryPermission({ mode });

    if (permission === 'prompt' && prompt && handle.requestPermission) {
      permission = await handle.requestPermission({ mode });
    }

    if (permission !== 'granted') {
      throw new DeviceError('ACCESS_LOST');
    }
  }

  private async file(entry: Entry): Promise<File> {
    await this.authorize(entry, 'read');

    if (entry.file) {
      return entry.file;
    }

    if (!entry.handle || !isFile(entry.handle)) {
      throw new DeviceError('WRONG_TYPE');
    }

    return entry.handle.getFile();
  }

  private directory(entry: Entry): FileSystemDirectoryHandle {
    if (!entry.handle || !isDirectory(entry.handle)) {
      throw new DeviceError('WRONG_TYPE');
    }

    return entry.handle;
  }

  async setCaptureMime(id: string, mime: string): Promise<void> {
    const entry = this.entry(id);

    if (entry.internal?.area !== 'data' || entry.ref.kind !== 'file') {
      throw new DeviceError('INVALID_ARGUMENT');
    }

    entry.captureMime = mime;
    await this.persist(entry);
  }

  private async metadata(entry: Entry): Promise<Metadata> {
    if (entry.ref.kind === 'directory') {
      return { ref: entry.ref, size: null, modifiedAt: null, mimeType: null, version: null };
    }

    const file = await this.file(entry);

    return {
      ref: entry.ref,
      size: file.size,
      modifiedAt: new Date(file.lastModified).toISOString(),
      mimeType: entry.captureMime || file.type || null,
      version: `${file.size}:${file.lastModified}`,
    };
  }

  private page<T>(
    items: T[],
    cursor: string | null,
    limit: number,
    scope: string,
  ): { entries: T[]; nextCursor: string | null } {
    let offset = 0;

    if (cursor) {
      const parsed = z
        .strictObject({
          scope: z.literal(scope),
          revision: z.literal(this.revision),
          offset: z.number().int().nonnegative(),
        })
        .safeParse(
          ((): unknown => {
            try {
              return JSON.parse(atob(cursor));
            } catch {
              throw new DeviceError('CONFLICT');
            }
          })(),
        );

      if (!parsed.success) {
        throw new DeviceError('CONFLICT');
      }

      offset = parsed.data.offset;
    }

    return {
      entries: items.slice(offset, offset + limit),
      nextCursor:
        offset + limit < items.length
          ? btoa(JSON.stringify({ scope, revision: this.revision, offset: offset + limit }))
          : null,
    };
  }

  private acquire(name: string): Promise<() => void> {
    return new Promise((resolve, reject): void => {
      void navigator.locks
        .request(`gchat-device-${name}`, { ifAvailable: true }, async (lock): Promise<void> => {
          if (!lock) {
            reject(new DeviceError('BUSY'));

            return;
          }

          await new Promise<void>((release): void => resolve(release));
        })
        .catch(reject);
    });
  }

  private async absent(directory: FileSystemDirectoryHandle, name: string): Promise<void> {
    try {
      await directory.getFileHandle(name);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError') {
        try {
          await directory.getDirectoryHandle(name);
        } catch (second) {
          if (second instanceof DOMException && second.name === 'NotFoundError') {
            return;
          }

          throw second;
        }
      } else if (!(error instanceof DOMException && error.name === 'TypeMismatchError')) {
        throw error;
      }
    }

    throw new DeviceError('ALREADY_EXISTS');
  }

  private ensure(epoch: number): void {
    if (epoch !== this.epoch) {
      throw new DeviceError('CANCELLED');
    }
  }

  private async choose<T>(action: (current: () => void) => Promise<T>): Promise<T> {
    if (this.dialog) {
      throw new DeviceError('BUSY');
    }

    this.dialog = true;
    const epoch = this.epoch;

    try {
      const result = await action((): void => this.ensure(epoch));

      if (epoch !== this.epoch) {
        throw new DeviceError('CANCELLED');
      }

      return result;
    } finally {
      this.dialog = false;
    }
  }

  /** Dispatch before an await so that pickers retain browser user activation. */
  execute(command: string, raw: unknown): Promise<unknown> {
    if (command === 'file.pick') {
      const args = argsSchemas['file.pick'].parse(raw);

      return this.choose(async (current): Promise<unknown> => {
        const pending = window.showOpenFilePicker
          ? window.showOpenFilePicker({
              multiple: args.multiple,
              ...(args.accept.length
                ? {
                    types: [
                      {
                        accept: Object.fromEntries(
                          args.accept.map((mime): [string, string[]] => [mime, []]),
                        ),
                      },
                    ],
                  }
                : {}),
            })
          : undefined;

        if (pending) {
          const handles = await pending;

          current();

          return {
            outcome: 'completed',
            entries: await Promise.all(
              handles.map(async (handle): Promise<Metadata> =>
                this.metadata(await this.retain(handle)),
              ),
            ),
          };
        }

        const files = await new Promise<File[]>((resolve): void => {
          const input = document.createElement('input');

          input.type = 'file';
          input.multiple = args.multiple;
          input.accept = args.accept.join(',');
          this.cancelInput = (): void => {
            resolve([]);
            input.remove();
            this.cancelInput = undefined;
          };
          input.onchange = (): void => {
            this.cancelInput = undefined;
            resolve(Array.from(input.files ?? []));
            input.remove();
          };
          input.oncancel = (): void => {
            this.cancelInput = undefined;
            resolve([]);
            input.remove();
          };
          input.hidden = true;
          document.body.append(input);
          input.click();
        });

        current();
        const entries: Metadata[] = [];

        for (const file of files) {
          const id = crypto.randomUUID();
          const entry: Entry = {
            ref: { id, name: file.name, kind: 'file', persistence: 'session' },
            file,
            root: id,
          };

          this.entries.set(id, entry);
          entries.push(await this.metadata(entry));
        }

        this.touch();

        return { outcome: files.length ? 'completed' : 'cancelled', entries };
      });
    }

    if (command === 'directory.pick') {
      return this.choose(async (current): Promise<unknown> => {
        if (!window.showDirectoryPicker) {
          throw new DeviceError('UNSUPPORTED');
        }

        const handle = await window.showDirectoryPicker();

        current();

        return { outcome: 'completed', entry: await this.metadata(await this.retain(handle)) };
      });
    }

    if (command === 'file.saveAs') {
      const args = argsSchemas['file.saveAs'].parse(raw);

      return this.choose(async (current): Promise<unknown> => {
        if (!window.showSaveFilePicker) {
          throw new DeviceError('UNSUPPORTED');
        }

        const pending = window.showSaveFilePicker({ suggestedName: args.suggestedName });
        const target = await pending;

        current();
        const source = await this.file(this.entry(args.sourceFileId));

        current();
        await source.stream().pipeTo(await target.createWritable());

        return { outcome: 'completed', entry: await this.metadata(await this.retain(target)) };
      });
    }

    return this.perform(command, raw);
  }

  private async perform(command: string, raw: unknown): Promise<unknown> {
    const epoch = this.epoch;

    await this.load();
    this.ensure(epoch);

    switch (command) {
      case 'storage.getRoot': {
        const { area } = argsSchemas[command].parse(raw);
        const handle = await this.storage.root(area);

        this.ensure(epoch);

        for (const entry of this.entries.values()) {
          if (entry.internal?.area === area && entry.internal.components.length === 0) {
            return entry.ref;
          }
        }

        const id = crypto.randomUUID();
        const entry: Entry = {
          ref: {
            id,
            name: area,
            kind: 'directory',
            persistence: area === 'temporary' ? 'session' : 'persistent',
          },
          handle,
          root: id,
          internal: { area, components: [] },
        };

        await this.persist(entry);
        this.entries.set(id, entry);

        return entry.ref;
      }
      case 'storage.getUsage':
        return this.storage.usage(argsSchemas[command].parse(raw).area);
      case 'file.access.list': {
        const a = argsSchemas[command].parse(raw);

        return this.page(
          [...this.entries.values()]
            .filter((e): boolean => !e.internal && e.root === e.ref.id)
            .map((e): FileRef => e.ref),
          a.cursor,
          a.limit,
          'grants',
        );
      }
      case 'file.access.restore': {
        const a = argsSchemas[command].parse(raw);
        const entry = this.entry(a.id);

        if (entry.internal) {
          throw new DeviceError('INVALID_ARGUMENT');
        }

        await this.authorize(entry, 'read', true);

        return this.metadata(entry);
      }
      case 'file.access.forget': {
        const a = argsSchemas[command].parse(raw);
        const entry = this.entry(a.id);

        if (entry.internal) {
          throw new DeviceError('INVALID_ARGUMENT');
        }

        if (entry.ref.persistence === 'persistent') {
          await this.transaction((store): void => {
            store.delete(a.id);
          });
        }

        for (const [writeId, write] of this.writes) {
          if (write.entry.root === entry.root) {
            await this.perform('file.write.abort', { writeId });
          }
        }

        for (const [id, value] of this.entries) {
          if (id === a.id || value.root === a.id) {
            this.entries.delete(id);
          }
        }

        this.touch();

        return { outcome: 'completed' };
      }
      case 'file.stat':
        return this.metadata(this.entry(argsSchemas[command].parse(raw).id));
      case 'directory.list': {
        const a = argsSchemas[command].parse(raw);
        const entry = this.entry(a.directoryId);

        await this.authorize(entry, 'read');
        const items: Metadata[] = [];

        for await (const handle of this.directory(entry).values()) {
          items.push(await this.metadata(await this.retain(handle, a.directoryId)));
        }

        items.sort((x, y): number => x.ref.name.localeCompare(y.ref.name));

        return this.page(items, a.cursor, a.limit, a.directoryId);
      }
      case 'file.read': {
        const a = argsSchemas[command].parse(raw);
        const file = await this.file(this.entry(a.fileId));
        const bytes = new Uint8Array(await file.slice(a.offset, a.offset + a.length).arrayBuffer());
        let binary = '';

        for (const byte of bytes) {
          binary += String.fromCharCode(byte);
        }

        return {
          dataBase64: btoa(binary),
          bytesRead: bytes.length,
          eof: a.offset + bytes.length >= file.size,
          version: `${file.size}:${file.lastModified}`,
        };
      }
      case 'file.create':
      case 'directory.create': {
        const a = argsSchemas[command].parse(raw);
        const entry = this.entry(a.directoryId);

        await this.authorize(entry, 'readwrite', true);
        this.ensure(epoch);
        const dir = this.directory(entry);

        await this.absent(dir, a.name);
        const handle =
          command === 'file.create'
            ? await dir.getFileHandle(a.name, { create: true })
            : await dir.getDirectoryHandle(a.name, { create: true });

        return this.metadata(await this.retain(handle, a.directoryId));
      }
      case 'file.write.begin': {
        const a = argsSchemas[command].parse(raw);
        const entry = this.entry(a.fileId);

        await this.authorize(entry, 'readwrite', true);
        this.ensure(epoch);

        if (!entry.handle || !isFile(entry.handle)) {
          throw new DeviceError('UNSUPPORTED');
        }

        if ([...this.writes.values()].some((w): boolean => w.entry === entry)) {
          throw new DeviceError('BUSY');
        }

        const source = await this.file(entry);
        const version = `${source.size}:${source.lastModified}`;

        if (a.expectedVersion !== null && version !== a.expectedVersion) {
          throw new DeviceError('CONFLICT');
        }

        if (!navigator.storage?.getDirectory || !navigator.locks) {
          throw new DeviceError('UNSUPPORTED');
        }

        const writeId = crypto.randomUUID();
        const releaseTarget = await this.acquire(`target-${entry.ref.id}`);
        let releaseStage: (() => void) | undefined;

        try {
          releaseStage = await this.acquire(`write-${writeId}`);
          const root = await navigator.storage.getDirectory();
          const tempName = `gchat-write-${writeId}`;
          const temp = await root.getFileHandle(tempName, { create: true });

          if (a.mode === 'update') {
            await source.stream().pipeTo(await temp.createWritable());
          }

          const writer = await temp.createWritable({ keepExistingData: a.mode === 'update' });

          if (epoch !== this.epoch) {
            await writer.abort();

            throw new DeviceError('CANCELLED');
          }

          const stage = releaseStage;

          this.writes.set(writeId, {
            entry,
            writer,
            temp,
            tempName,
            size: a.mode === 'update' ? source.size : 0,
            expected: a.expectedVersion,
            release: (): void => {
              stage();
              releaseTarget();
            },
          });
        } catch (error) {
          releaseStage?.();
          releaseTarget();

          throw error;
        }

        return { writeId };
      }
      case 'file.write.chunk': {
        const a = argsSchemas[command].parse(raw);
        const write = this.writes.get(a.writeId);

        if (!write) {
          throw new DeviceError('NOT_FOUND');
        }

        const bytes = Uint8Array.from(atob(a.dataBase64), (c): number => c.charCodeAt(0));

        if (bytes.length > 262144 || a.offset > write.size) {
          throw new DeviceError('INVALID_ARGUMENT');
        }

        await write.writer.write({ type: 'write', position: a.offset, data: bytes });
        write.size = Math.max(write.size, a.offset + bytes.length);

        return { bytesWritten: bytes.length };
      }
      case 'file.write.commit': {
        const a = argsSchemas[command].parse(raw);
        const write = this.writes.get(a.writeId);

        if (!write) {
          throw new DeviceError('NOT_FOUND');
        }

        if (
          write.expected !== null &&
          (await this.metadata(write.entry)).version !== write.expected
        ) {
          throw new DeviceError('CONFLICT');
        }

        this.ensure(epoch);
        await write.writer.close();

        try {
          this.ensure(epoch);
          const handle = write.entry.handle;

          if (!handle || !isFile(handle)) {
            throw new DeviceError('WRONG_TYPE');
          }

          await (await write.temp.getFile()).stream().pipeTo(await handle.createWritable());
        } catch {
          throw new DeviceError('OUTCOME_UNKNOWN');
        } finally {
          this.writes.delete(a.writeId);
          write.release();
          await (
            await navigator.storage.getDirectory()
          )
            .removeEntry(write.tempName)
            .catch((): void => {});
        }

        this.touch();

        return this.metadata(write.entry);
      }
      case 'file.write.abort': {
        const a = argsSchemas[command].parse(raw);
        const write = this.writes.get(a.writeId);

        if (write) {
          this.writes.delete(a.writeId);

          try {
            await write.writer.abort();
            await (await navigator.storage.getDirectory()).removeEntry(write.tempName);
          } finally {
            write.release();
          }
        }

        return { outcome: 'completed' };
      }
      case 'file.export': {
        const a = argsSchemas[command].parse(raw);
        const file = await this.file(this.entry(a.sourceFileId));
        const url = URL.createObjectURL(file);
        const link = document.createElement('a');

        link.href = url;
        link.download = a.suggestedName;
        link.click();
        setTimeout((): void => URL.revokeObjectURL(url), 60000);

        return { outcome: 'completed' };
      }
      case 'file.copy': {
        const a = argsSchemas[command].parse(raw);
        const source = this.entry(a.id);
        const destination = this.entry(a.destinationDirectoryId);

        await this.authorize(destination, 'readwrite', true);
        this.ensure(epoch);
        const dir = this.directory(destination);

        this.preventSubtree(source, destination);

        await this.absent(dir, a.name);
        const created = await this.copy(source, dir, a.name, a.destinationDirectoryId);

        this.touch();

        return this.metadata(created);
      }
      case 'file.move':
      case 'file.rename': {
        const a = argsSchemas[command].parse(raw);
        const source = this.entry(a.id);

        if (source.internal?.components.length === 0) {
          throw new DeviceError('INVALID_ARGUMENT');
        }

        const parentId =
          command === 'file.move'
            ? argsSchemas['file.move'].parse(raw).destinationDirectoryId
            : source.parent;

        if (!parentId || !source.handle?.move) {
          throw new DeviceError('UNSUPPORTED');
        }

        const destination = this.entry(parentId);
        const dir = this.directory(destination);

        await this.authorize(source, 'readwrite', true);
        await this.authorize(destination, 'readwrite', true);
        this.ensure(epoch);
        this.preventSubtree(source, destination);
        await this.absent(dir, a.name);
        await source.handle.move(dir, a.name);
        const previousInternal = source.internal;
        const targetInternal = destination.internal;

        source.parent = parentId;
        source.ref.name = a.name;
        source.root = destination.root;
        source.internal = targetInternal
          ? { area: targetInternal.area, components: [...targetInternal.components, a.name] }
          : undefined;
        source.ref.persistence =
          source.internal?.area === 'temporary' ||
          (!source.internal && destination.ref.persistence === 'session')
            ? 'session'
            : 'persistent';
        await this.persist(source);

        if (previousInternal) {
          for (const entry of this.entries.values()) {
            if (
              entry === source ||
              entry.internal?.area !== previousInternal.area ||
              !this.isPrefix(previousInternal.components, entry.internal.components)
            ) {
              continue;
            }

            const tail = entry.internal.components.slice(previousInternal.components.length);

            entry.internal = source.internal
              ? { area: source.internal.area, components: [...source.internal.components, ...tail] }
              : undefined;
            entry.root = source.root;
            entry.ref.persistence = source.ref.persistence;
            await this.persist(entry);
          }
        }

        this.touch();

        return this.metadata(source);
      }
      case 'file.remove': {
        const a = argsSchemas[command].parse(raw);
        const entry = this.entry(a.id);

        if (entry.internal?.components.length === 0) {
          throw new DeviceError('INVALID_ARGUMENT');
        }

        if (!entry.parent) {
          throw new DeviceError('UNSUPPORTED');
        }

        const parent = this.entry(entry.parent);

        await this.authorize(parent, 'readwrite', true);
        this.ensure(epoch);
        await this.directory(parent).removeEntry(entry.ref.name, { recursive: a.recursive });

        const removed = [...this.entries.values()].filter(
          (value): boolean =>
            value.ref.id === a.id ||
            (entry.internal && value.internal?.area === entry.internal.area
              ? this.isPrefix(entry.internal.components, value.internal.components)
              : this.descends(value, entry.ref.id)),
        );

        await this.transaction((store): void => {
          for (const value of removed) {
            store.delete(value.ref.id);
          }
        }).catch((error): void => {
          if (entry.internal) {
            throw error;
          }
        });

        for (const value of removed) {
          this.entries.delete(value.ref.id);
        }

        this.touch();

        return { outcome: 'completed' };
      }
      default:
        throw new DeviceError('UNSUPPORTED');
    }
  }

  private isPrefix(parent: string[], child: string[]): boolean {
    return (
      parent.length <= child.length && parent.every((part, index): boolean => part === child[index])
    );
  }

  private descends(entry: Entry, parent: string): boolean {
    const visited = new Set<string>();
    let current = entry;

    while (current.parent && !visited.has(current.ref.id)) {
      if (current.parent === parent) {
        return true;
      }

      visited.add(current.ref.id);
      const next = this.entries.get(current.parent);

      if (!next) {
        break;
      }

      current = next;
    }

    return false;
  }

  private preventSubtree(source: Entry, destination: Entry): void {
    if (
      source.ref.id === destination.ref.id ||
      this.descends(destination, source.ref.id) ||
      (source.internal &&
        destination.internal?.area === source.internal.area &&
        this.isPrefix(source.internal.components, destination.internal.components))
    ) {
      throw new DeviceError('INVALID_ARGUMENT');
    }
  }

  async stop(): Promise<void> {
    this.epoch++;

    for (const writeId of [...this.writes.keys()]) {
      await this.perform('file.write.abort', { writeId });
    }

    await this.storage.stop();

    for (const [id, entry] of this.entries) {
      if (entry.internal?.area === 'temporary') {
        this.entries.delete(id);
      }
    }
  }

  private async copy(
    source: Entry,
    destination: FileSystemDirectoryHandle,
    name: string,
    parent: string,
  ): Promise<Entry> {
    let created: Entry | undefined;

    try {
      if (source.ref.kind === 'file') {
        const target = await destination.getFileHandle(name, { create: true });

        created = await this.retain(target, parent);
        await (await this.file(source)).stream().pipeTo(await target.createWritable());
      } else {
        const target = await destination.getDirectoryHandle(name, { create: true });

        created = await this.retain(target, parent);

        for await (const child of this.directory(source).values()) {
          await this.copy(
            await this.retain(child, source.ref.id),
            target,
            child.name,
            created.ref.id,
          );
        }
      }

      return created;
    } catch {
      throw new DeviceError('PARTIAL_FAILURE', {
        completedIds: [],
        ...(created ? { destinationId: created.ref.id } : {}),
      });
    }
  }

  reset(): void {
    this.epoch++;

    for (const [writeId] of this.writes) {
      void this.perform('file.write.abort', { writeId }).catch((): void => {});
    }
  }
}
