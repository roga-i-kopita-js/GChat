import { afterEach, describe, expect, it, vi } from 'vitest';

import { BrowserFiles } from './browser-files';
import { metadataSchema, resultsSchemas } from './contract';

afterEach((): void => {
  vi.unstubAllGlobals();
});
describe('browser file references', (): void => {
  it('reads bounded binary chunks and forgets access without deleting the selected file', async (): Promise<void> => {
    const file = new File([new Uint8Array(262145).fill(137)], 'fixture.bin');
    const handle = {
      kind: 'file',
      name: file.name,
      isSameEntry: async (other: unknown): Promise<boolean> => other === handle,
      getFile: async (): Promise<File> => file,
    };

    vi.stubGlobal('window', { showOpenFilePicker: async (): Promise<unknown[]> => [handle] });
    vi.stubGlobal('indexedDB', undefined);
    const changed = vi.fn();
    const files = new BrowserFiles(changed);
    const picked = resultsSchemas['file.pick'].parse(
      await files.execute('file.pick', { multiple: false, accept: [] }),
    );
    const id = picked.entries[0].ref.id;

    expect(picked.entries[0].ref.persistence).toBe('session');
    const first = resultsSchemas['file.read'].parse(
      await files.execute('file.read', { fileId: id, offset: 0, length: 262144 }),
    );

    expect(first.bytesRead).toBe(262144);
    expect(atob(first.dataBase64).charCodeAt(0)).toBe(137);
    expect(first.eof).toBe(false);
    const last = resultsSchemas['file.read'].parse(
      await files.execute('file.read', { fileId: id, offset: 262144, length: 1 }),
    );

    expect(last.eof).toBe(true);
    expect(last.bytesRead).toBe(1);
    await files.execute('file.access.forget', { id });
    await expect(files.execute('file.stat', { id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await handle.getFile()).size).toBe(262145);
    expect(changed).toHaveBeenCalled();
  });
  it('does not expose platform paths or accept a forged reference', async (): Promise<void> => {
    const files = new BrowserFiles((): void => {});

    vi.stubGlobal('indexedDB', undefined);
    await expect(files.execute('file.stat', { id: crypto.randomUUID() })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(
      metadataSchema.safeParse({
        ref: {
          id: crypto.randomUUID(),
          name: 'file',
          kind: 'file',
          persistence: 'persistent',
          path: '/private/file',
        },
        size: 0,
        modifiedAt: null,
        mimeType: null,
        version: null,
      }).success,
    ).toBe(false);
  });
});
