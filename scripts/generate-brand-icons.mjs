import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(root, 'docs/design/branding/gchat-icon-generated.png');
const web = resolve(root, 'applications/web/public');
const ios = resolve(root, 'applications/ios/Resources/Assets.xcassets');
const android = resolve(root, 'docs/design/branding/android');

function resize(size, path) {
  mkdirSync(dirname(path), { recursive: true });
  execFileSync(
    'sips',
    ['-s', 'format', 'png', '-z', String(size), String(size), source, '--out', path],
    { stdio: 'pipe' },
  );
}
function json(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
}

for (const size of [16, 32, 48, 64, 144, 180, 192, 256, 512, 1024]) {
  resize(size, resolve(web, `icons/icon-${size}.png`));
}

resize(180, resolve(web, 'apple-touch-icon.png'));

// ICO entries contain the same lossless PNGs, at their native resolutions.
const sizes = [16, 32, 48, 256];
const images = sizes.map((size) => readFileSync(resolve(web, `icons/icon-${size}.png`)));
const header = Buffer.alloc(6 + sizes.length * 16);

header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
let offset = header.length;

for (const [index, size] of sizes.entries()) {
  const entry = 6 + index * 16;

  header[entry] = size === 256 ? 0 : size;
  header[entry + 1] = size === 256 ? 0 : size;
  header.writeUInt16LE(1, entry + 4);
  header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(images[index].length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += images[index].length;
}

writeFileSync(resolve(web, 'favicon.ico'), Buffer.concat([header, ...images]));

// Keep the complete mark inside the maskable icon's central safe circle.
const maskable = resolve(web, 'icons/maskable-512.png');

resize(512, maskable);

json(resolve(web, 'site.webmanifest'), {
  id: '/',
  name: 'GChat',
  short_name: 'GChat',
  lang: 'ru',
  description: 'Голосовые звонки вашим близким.',
  start_url: '/calls',
  scope: '/',
  display: 'standalone',
  theme_color: '#087cf0',
  background_color: '#f4f6f9',
  icons: [
    { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
});

const catalog = [];

for (const [idiom, points, scales] of [
  ['iphone', 20, [2, 3]],
  ['iphone', 29, [2, 3]],
  ['iphone', 40, [2, 3]],
  ['iphone', 60, [2, 3]],
  ['ipad', 20, [1, 2]],
  ['ipad', 29, [1, 2]],
  ['ipad', 40, [1, 2]],
  ['ipad', 76, [1, 2]],
  ['ipad', 83.5, [2]],
  ['ios-marketing', 1024, [1]],
]) {
  for (const scale of scales) {
    const pixels = points * scale;
    const filename = `icon-${pixels}.png`;

    resize(pixels, resolve(ios, 'AppIcon.appiconset', filename));
    catalog.push({ idiom, size: `${points}x${points}`, scale: `${scale}x`, filename });
  }
}

json(resolve(ios, 'Contents.json'), { info: { author: 'xcode', version: 1 } });
json(resolve(ios, 'AppIcon.appiconset/Contents.json'), {
  images: catalog,
  info: { author: 'xcode', version: 1 },
});

for (const [density, size] of [
  ['mdpi', 48],
  ['hdpi', 72],
  ['xhdpi', 96],
  ['xxhdpi', 144],
  ['xxxhdpi', 192],
]) {
  resize(size, resolve(android, `mipmap-${density}/ic_launcher.png`));
}

resize(512, resolve(android, 'play-store-512.png'));
console.log('Generated web, iOS and Android icon assets.');
