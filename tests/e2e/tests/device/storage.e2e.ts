import { expect, test } from '@playwright/test';

test('OPFS restores internal refs, excludes grants and protects roots across reload', async ({
  page,
}): Promise<void> => {
  await page.goto('/');
  const previous = await page.evaluate(async (): Promise<{ root: string; file: string }> => {
    const path = '/tests/storage-harness.ts';
    const { files, storage, StorageArea } = await import(path);
    const root = await storage.getRoot(StorageArea.Data);
    const created = await files.execute('file.create', {
      directoryId: root.id,
      name: 'fixture.bin',
    });
    const write = await files.execute('file.write.begin', {
      fileId: created.ref.id,
      mode: 'replace',
      expectedVersion: null,
    });

    await files.execute('file.write.chunk', {
      writeId: write.writeId,
      offset: 0,
      dataBase64: btoa('\x00\xff\x01'),
    });
    await files.execute('file.write.commit', { writeId: write.writeId });
    const usage = await storage.getUsage(StorageArea.Data);

    if (usage.usedBytes !== 3 || usage.quotaBytes !== null) {
      throw new Error('usage');
    }

    const grants = await files.execute('file.access.list', { cursor: null, limit: 10 });

    if (grants.entries.length) {
      throw new Error('internal grant leaked');
    }

    for (const command of [
      'file.remove',
      'file.rename',
      'file.move',
      'file.access.forget',
      'file.access.restore',
    ]) {
      try {
        await files.execute(
          command,
          command === 'file.remove'
            ? { id: root.id, recursive: true }
            : command === 'file.rename'
              ? { id: root.id, name: 'bad' }
              : command === 'file.move'
                ? { id: root.id, name: 'bad', destinationDirectoryId: root.id }
                : { id: root.id },
        );

        throw new Error('root modification accepted');
      } catch (error) {
        if ((error as { code: string }).code !== 'INVALID_ARGUMENT') {
          throw error;
        }
      }
    }

    return { root: root.id, file: created.ref.id };
  });

  await page.reload();
  expect(
    await page.evaluate(async (refs): Promise<boolean> => {
      const path = '/tests/storage-harness.ts';
      const { files, storage, StorageArea } = await import(path);
      const root = await storage.getRoot(StorageArea.Data);
      const read = await files.execute('file.read', { fileId: refs.file, offset: 0, length: 10 });

      await files.execute('file.remove', { id: refs.file, recursive: false });

      return root.id === refs.root && read.dataBase64 === 'AP8B';
    }, previous),
  ).toBe(true);
});

test('temporary cleanup preserves another live document and recovers abandoned owner', async ({
  context,
  page,
}): Promise<void> => {
  await page.goto('/');
  const prepare = async (): Promise<string> =>
    page.evaluate(async (): Promise<string> => {
      const path = '/tests/storage-harness.ts';
      const { files, storage, StorageArea } = await import(path);
      const root = await storage.getRoot(StorageArea.Temporary);
      const dir = await files.execute('directory.create', { directoryId: root.id, name: 'alive' });

      return dir.ref.id;
    });
  const ref = await prepare();
  const other = await context.newPage();

  await other.goto('/');
  await other.evaluate(async (): Promise<void> => {
    const path = '/tests/storage-harness.ts';
    const { storage, StorageArea } = await import(path);

    await storage.getRoot(StorageArea.Temporary);
  });
  expect(
    await page.evaluate(async (id): Promise<boolean> => {
      const path = '/tests/storage-harness.ts';
      const { files } = await import(path);

      return (await files.execute('file.stat', { id })).ref.kind === 'directory';
    }, ref),
  ).toBe(true);
  await other.close();
  await page.reload();
  expect(
    await page.evaluate(async (): Promise<number> => {
      const path = '/tests/storage-harness.ts';
      const { storage, StorageArea } = await import(path);

      await storage.getRoot(StorageArea.Temporary);
      const base = await (
        await navigator.storage.getDirectory()
      ).getDirectoryHandle('gchat-device-storage-v1');
      const temp = await base.getDirectoryHandle('temporary');
      let count = 0;

      for await (const _entry of (
        temp as FileSystemDirectoryHandle & { values(): AsyncIterable<FileSystemHandle> }
      ).values()) {
        count++;
      }

      return count;
    }),
  ).toBe(1);
});

test('rejects recursive copies into source and invalidates removed descendant refs', async ({
  page,
}): Promise<void> => {
  await page.goto('/');
  expect(
    await page.evaluate(async (): Promise<boolean> => {
      const path = '/tests/storage-harness.ts';
      const { files, storage, StorageArea } = await import(path);
      const root = await storage.getRoot(StorageArea.Cache);
      const parent = await files.execute('directory.create', {
        directoryId: root.id,
        name: 'fixture',
      });
      const child = await files.execute('directory.create', {
        directoryId: parent.ref.id,
        name: 'child',
      });
      const file = await files.execute('file.create', {
        directoryId: child.ref.id,
        name: 'file.bin',
      });

      try {
        await files.execute('file.copy', {
          id: parent.ref.id,
          destinationDirectoryId: child.ref.id,
          name: 'loop',
        });

        throw new Error('recursive copy accepted');
      } catch (error) {
        if ((error as { code: string }).code !== 'INVALID_ARGUMENT') {
          throw error;
        }
      }

      await files.execute('file.remove', { id: parent.ref.id, recursive: true });

      try {
        await files.execute('file.stat', { id: file.ref.id });

        return false;
      } catch (error) {
        return (error as { code: string }).code === 'NOT_FOUND';
      }
    }),
  ).toBe(true);
});

test('moves an internal file across areas and restores the same ID in Data', async ({
  page,
}): Promise<void> => {
  await page.goto('/');
  const id = await page.evaluate(async (): Promise<string> => {
    const path = '/tests/storage-harness.ts';
    const { files, storage, StorageArea } = await import(path);
    const temporary = await storage.getRoot(StorageArea.Temporary);
    const data = await storage.getRoot(StorageArea.Data);
    const file = await files.execute('file.create', {
      directoryId: temporary.id,
      name: 'moving.bin',
    });
    const moved = await files.execute('file.move', {
      id: file.ref.id,
      destinationDirectoryId: data.id,
      name: 'moved.bin',
    });

    if (moved.ref.id !== file.ref.id || moved.ref.persistence !== 'persistent') {
      throw new Error('move changed identity or persistence');
    }

    return moved.ref.id;
  });

  await page.reload();
  expect(
    await page.evaluate(async (id): Promise<boolean> => {
      const path = '/tests/storage-harness.ts';
      const { files } = await import(path);
      const file = await files.execute('file.stat', { id });

      await files.execute('file.remove', { id, recursive: false });

      return file.ref.id === id && file.ref.name === 'moved.bin';
    }, id),
  ).toBe(true);
});
