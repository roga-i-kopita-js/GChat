import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrations } from './migrations.js';
import { validateDatabaseUrl } from './database-url.js';

describe('Migration prerequisites', () => {
  let folder: string;
  beforeEach(async () => { folder = await mkdtemp(join(tmpdir(), 'gchat-migrations-')); });
  afterEach(async () => { await rm(folder, { recursive: true, force: true }); });

  it('accepts an empty committed history without requiring a database', async () => {
    await mkdir(join(folder, 'meta'));
    await writeFile(join(folder, 'meta/_journal.json'), JSON.stringify({ version: '7', dialect: 'postgresql', entries: [] }));
    await expect(runMigrations('postgresql://unused:unused@127.0.0.1:1/unused', folder)).resolves.toBeUndefined();
  });

  it('fails for missing artifacts rather than silently skipping migrations', async () => {
    await expect(runMigrations('postgresql://unused:unused@127.0.0.1:1/unused', folder)).rejects.toThrow();
    await mkdir(join(folder, 'meta'));
    await writeFile(join(folder, 'meta/_journal.json'), JSON.stringify({
      entries: [{ idx: 0, tag: '0000_missing', when: 1, breakpoints: true }],
    }));
    await expect(runMigrations('postgresql://unused:unused@127.0.0.1:1/unused', folder)).rejects.toThrow();
  });

  it.each([undefined, '', 'redis://private:secret@host/0', 'postgresql:///missing-host'])('sanitizes invalid configuration', (url) => {
    expect(() => validateDatabaseUrl(url)).toThrow('DATABASE_URL must be a valid PostgreSQL connection URL');
  });
});
