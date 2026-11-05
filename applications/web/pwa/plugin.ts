import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Plugin } from 'vite';

const directory = dirname(fileURLToPath(import.meta.url));

/** Emit one immutable application shell per build, including both supported URL layouts. */
export function pwaPlugin(server: boolean): Plugin {
  const base = server ? '/apps/' : '/';
  const startPath = server ? '/apps/client' : '';
  const manifest = JSON.parse(
    readFileSync(resolve(directory, '../public/site.webmanifest'), 'utf8'),
  );

  manifest.id = server ? '/apps/client' : '/';
  manifest.scope = server ? '/apps/client' : '/';
  manifest.start_url = `${startPath}/calls`;

  for (const icon of manifest.icons) icon.src = base + icon.src.replace(/^\//, '');

  return {
    name: 'gchat-pwa',
    enforce: 'post',
    apply: 'build',
    generateBundle(_options, bundle): void {
      const htmlAsset = bundle['index.html'];

      if (htmlAsset?.type !== 'asset') throw new Error('PWA requires index.html');

      const html = String(htmlAsset.source);
      const assets = Object.keys(bundle)
        .filter((name): boolean => name !== 'index.html')
        .map((name): string => base + name);

      assets.push(
        ...readdirSync(resolve(directory, '../public/icons')).map(
          (name): string => `${base}icons/${name}`,
        ),
        `${base}apple-touch-icon.png`,
        `${base}favicon.ico`,
        `${base}site.webmanifest`,
      );
      const worker = readFileSync(resolve(directory, 'worker.js'), 'utf8');
      const manifestSource = JSON.stringify(manifest);
      const version = createHash('sha256')
        .update(JSON.stringify(bundle))
        .update(worker)
        .update(manifestSource);

      for (const name of readdirSync(resolve(directory, '../public/icons')))
        version.update(readFileSync(resolve(directory, '../public/icons', name)));

      for (const name of ['apple-touch-icon.png', 'favicon.ico'])
        version.update(readFileSync(resolve(directory, '../public', name)));

      const prefix = `gchat-shell-${server ? 'server' : 'root'}-`;

      this.emitFile({ type: 'asset', fileName: 'site.webmanifest', source: manifestSource });
      this.emitFile({
        type: 'asset',
        fileName: 'sw.js',
        source: worker.replace(
          '__GCHAT_PWA__',
          JSON.stringify({
            cachePrefix: prefix,
            cacheName: prefix + version.digest('hex').slice(0, 16),
            assets,
            html,
            startUrl: manifest.start_url,
            startPath,
            scope: manifest.scope,
            icon: `${base}icons/icon-192.png`,
          }),
        ),
      });
    },
  };
}
