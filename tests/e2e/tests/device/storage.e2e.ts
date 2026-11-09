import { expect, test } from '@playwright/test';

test('OPFS restores internal refs, excludes grants and protects roots across reload', async ({
  page,
}): Promise<void> => {
  await page.goto('/');
  const previous = await page.evaluate(async (): Promise<{ root: string; file: string }> => {
    const path = '/tests/storage-harness.ts';
    const { files, storage, StorageArea } = await import(path);
    const root = await storage.getRoot(StorageArea.Data);
    const { id: rootId } = root;
    const created = await files.execute('file.create', {
      directoryId: rootId,
      name: 'fixture.bin',
    });
    const { ref: createdRef } = created;
    const write = await files.execute('file.write.begin', {
      fileId: createdRef.id,
      mode: 'replace',
      expectedVersion: null,
    });

    const { writeId: writeWriteId } = write;

    await files.execute('file.write.chunk', {
      writeId: writeWriteId,
      offset: 0,
      dataBase64: btoa('\x00\xff\x01'),
    });
    const { writeId: writeWriteId2 } = write;

    await files.execute('file.write.commit', { writeId: writeWriteId2 });
    const usage = await storage.getUsage(StorageArea.Data);

    const { usedBytes: usageUsedBytes, quotaBytes: usageQuotaBytes } = usage;

    if (usageUsedBytes !== 3 || usageQuotaBytes !== null) {
      throw new Error('usage');
    }

    const { entries: grantsEntries } = await files.execute('file.access.list', {
      cursor: null,
      limit: 10,
    });

    if (grantsEntries.length) {
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
        const { id: rootId2 } = root;
        let selectedValue;

        if (command === 'file.remove') {
          selectedValue = { id: rootId2, recursive: true };
        } else if (command === 'file.rename') {
          selectedValue = { id: rootId2, name: 'bad' };
        } else if (command === 'file.move') {
          selectedValue = { id: rootId2, name: 'bad', destinationDirectoryId: rootId2 };
        } else {
          selectedValue = { id: rootId2 };
        }

        await files.execute(command, selectedValue);

        throw new Error('root modification accepted');
      } catch (error) {
        if ((error as { code: string }).code !== 'INVALID_ARGUMENT') {
          throw error;
        }
      }
    }

    const { id: rootId3 } = root;
    const { ref: createdRef2 } = created;

    return { root: rootId3, file: createdRef2.id };
  });

  await page.reload();
  expect(
    await page.evaluate(async (refs): Promise<boolean> => {
      const path = '/tests/storage-harness.ts';
      const { files, storage, StorageArea } = await import(path);
      const root = await storage.getRoot(StorageArea.Data);
      const read = await files.execute('file.read', { fileId: refs.file, offset: 0, length: 10 });

      await files.execute('file.remove', { id: refs.file, recursive: false });

      const { id: rootId4 } = root ?? {};
      const { dataBase64: readDataBase64 } = read;

      return rootId4 === refs.root && readDataBase64 === 'AP8B';
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
      const { id: rootId5 } = await storage.getRoot(StorageArea.Temporary);
      const { ref: dirRef } = await files.execute('directory.create', {
        directoryId: rootId5,
        name: 'alive',
      });

      return dirRef.id;
    });
  const ref = await prepare();
  const other = await context.newPage();

  const { goto: otherGoto } = other;

  await otherGoto.bind(other)('/');
  const { evaluate: otherEvaluate } = other;

  await otherEvaluate.bind(other)(async (): Promise<void> => {
    const path = '/tests/storage-harness.ts';
    const { storage, StorageArea } = await import(path);

    await storage.getRoot(StorageArea.Temporary);
  });
  expect(
    await page.evaluate(async (id): Promise<boolean> => {
      const path = '/tests/storage-harness.ts';
      const { files } = await import(path);

      const { ref: executeResultRef } = await files.execute('file.stat', { id });

      return executeResultRef.kind === 'directory';
    }, ref),
  ).toBe(true);
  const { close: otherClose } = other;

  await otherClose.bind(other)();
  await page.reload();
  expect(
    await page.evaluate(async (): Promise<number> => {
      const path = '/tests/storage-harness.ts';
      const { storage, StorageArea } = await import(path);

      await storage.getRoot(StorageArea.Temporary);
      const resolved = await navigator.storage.getDirectory();
      const { getDirectoryHandle: getDirectoryResultGetDirectoryHandle } = resolved;
      const base =
        await getDirectoryResultGetDirectoryHandle.bind(resolved)('gchat-device-storage-v1');
      const { getDirectoryHandle: baseGetDirectoryHandle } = base;
      const temp = await baseGetDirectoryHandle.bind(base)('temporary');
      let count = 0;

      const { values: tempValues } = temp as FileSystemDirectoryHandle & {
        values(): AsyncIterable<FileSystemHandle>;
      };

      for await (const _entry of tempValues.bind(
        temp as FileSystemDirectoryHandle & { values(): AsyncIterable<FileSystemHandle> },
      )()) {
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
      const { id: rootId6 } = await storage.getRoot(StorageArea.Cache);
      const parent = await files.execute('directory.create', {
        directoryId: rootId6,
        name: 'fixture',
      });
      const { ref: parentRef } = parent;
      const child = await files.execute('directory.create', {
        directoryId: parentRef.id,
        name: 'child',
      });
      const { ref: childRef } = child;
      const file = await files.execute('file.create', {
        directoryId: childRef.id,
        name: 'file.bin',
      });

      try {
        const { ref: parentRef2 } = parent;
        const { ref: childRef2 } = child;

        await files.execute('file.copy', {
          id: parentRef2.id,
          destinationDirectoryId: childRef2.id,
          name: 'loop',
        });

        throw new Error('recursive copy accepted');
      } catch (error) {
        if ((error as { code: string }).code !== 'INVALID_ARGUMENT') {
          throw error;
        }
      }

      const { ref: parentRef3 } = parent;

      await files.execute('file.remove', { id: parentRef3.id, recursive: true });

      try {
        const { ref: fileRef } = file;

        await files.execute('file.stat', { id: fileRef.id });

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
    const { id: temporaryId } = temporary;
    const file = await files.execute('file.create', {
      directoryId: temporaryId,
      name: 'moving.bin',
    });
    const { ref: fileRef2 } = file;
    const { id: dataId } = data;
    const moved = await files.execute('file.move', {
      id: fileRef2.id,
      destinationDirectoryId: dataId,
      name: 'moved.bin',
    });

    const { ref: movedRef } = moved;
    const { ref: fileRef3 } = file;

    if (movedRef.id !== fileRef3.id || movedRef.persistence !== 'persistent') {
      throw new Error('move changed identity or persistence');
    }

    const { ref: movedRef2 } = moved;

    return movedRef2.id;
  });

  await page.reload();
  expect(
    await page.evaluate(async (id): Promise<boolean> => {
      const path = '/tests/storage-harness.ts';
      const { files } = await import(path);
      const file = await files.execute('file.stat', { id });

      await files.execute('file.remove', { id, recursive: false });

      const { ref: fileRef4 } = file;

      return fileRef4.id === id && fileRef4.name === 'moved.bin';
    }, id),
  ).toBe(true);
});
