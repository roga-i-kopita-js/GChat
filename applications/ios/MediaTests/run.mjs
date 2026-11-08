import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const inventory = spawnSync('xcrun', ['simctl', 'list', 'devices', 'available', '--json'], {
  encoding: 'utf8',
});

if (inventory.status !== 0) {
  process.stderr.write(inventory.stderr);
  process.exit(inventory.status ?? 1);
}

const phones = Object.values(JSON.parse(inventory.stdout).devices)
  .flat()
  .filter((device) => device.isAvailable && device.deviceTypeIdentifier.includes('.iPhone'));
const requested = process.env.GCHAT_IOS_SIMULATOR_ID;
const simulator = requested
  ? phones.find((device) => device.udid === requested)
  : (phones.find((device) => device.state === 'Booted') ?? phones[0]);

if (!simulator) {
  throw new Error(
    'An available iPhone Simulator is required; optionally set GCHAT_IOS_SIMULATOR_ID.',
  );
}

const result = spawnSync(
  'xcodebuild',
  [
    '-project',
    'MediaTests/MediaTests.xcodeproj',
    '-scheme',
    'GChatMediaTests',
    '-destination',
    `platform=iOS Simulator,id=${simulator.udid}`,
    '-derivedDataPath',
    resolve(tmpdir(), 'gchat-media-tests'),
    'CODE_SIGN_IDENTITY=-',
    'test',
  ],
  { cwd: fileURLToPath(new URL('../', import.meta.url)), stdio: 'inherit' },
);

process.exit(result.status ?? 1);
