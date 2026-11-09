import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { stickerIds } from './index.js';

test('fixed catalog preserves source/PNG hashes, transparent RGBA dimensions and licensing', async () => {
  const root = new URL('./', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));

  assert.equal(manifest.version, 1);
  assert.deepEqual(
    manifest.stickers.map((s) => s.id),
    stickerIds,
  );
  assert.equal(new Set(stickerIds).size, 5);
  assert.match(await readFile(new URL('LICENSE.txt', root), 'utf8'), /CC0 1.0 Universal/);

  for (const item of manifest.stickers) {
    const original = await readFile(new URL(`originals/${item.id}.svg`, root));
    const png = await readFile(new URL(`images/${item.id}.png`, root));

    assert.equal(createHash('sha256').update(original).digest('hex'), item.original_sha256);
    assert.equal(createHash('sha256').update(png).digest('hex'), item.png_sha256);
    const { subarray: pngSubarray } = png;

    assert.equal(pngSubarray.bind(png)(1, 4).toString(), 'PNG');
    const { readUInt32BE: pngReadUInt32BE } = png;

    assert.equal(pngReadUInt32BE.bind(png)(16), 512);
    const { readUInt32BE: pngReadUInt32BE2 } = png;

    assert.equal(pngReadUInt32BE2.bind(png)(20), 512);
    const { [25]: png25 } = png;

    assert.equal(png25, 6);
    const { toString: originalToString } = original;

    assert.match(originalToString.bind(original)(), /CC0-1.0/);
    assert.match(
      item.source,
      /^https:\/\/www\.assetpolish\.com\/assets\/colour-animals\/[^/]+\.svg$/,
    );
  }
});
