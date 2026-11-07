import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import { hashPassword } from '../../../applications/backend/dist/auth/auth.password.js';
import { runMigrations } from '../../../applications/backend/dist/database/migrations.js';

// Dedicated, loopback-only Compose fixture. Never reads a developer's .env or DATABASE_URL.
const url = 'postgresql://gchat_web_test:gchat_web_test_only@127.0.0.1:55439/gchat_web_test';
const backend = fileURLToPath(new URL('../../../applications/backend/', import.meta.url));
const local = fileURLToPath(new URL('../.local/', import.meta.url));

await mkdir(local, { recursive: true });

// Native Chromium fake microphone: looping mono PCM, 440/660 Hz alternating.
// Both tones are distinct from the reference peer's 880 Hz.
const sampleRate = 48000;
const samples = sampleRate;
const wav = Buffer.alloc(44 + samples * 2);

wav.write('RIFF', 0);
wav.writeUInt32LE(wav.length - 8, 4);
wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(sampleRate, 24);
wav.writeUInt32LE(sampleRate * 2, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write('data', 36);
wav.writeUInt32LE(samples * 2, 40);

for (let index = 0; index < samples; index++) {
  const time = index / sampleRate;
  const frequency = time < 0.5 ? 440 : 660;
  const envelope = 0.65 + 0.35 * Math.sin(2 * Math.PI * 8 * time);

  wav.writeInt16LE(
    Math.round(0.3 * envelope * 32767 * Math.sin(2 * Math.PI * frequency * time)),
    44 + index * 2,
  );
}

await writeFile(resolve(local, 'microphone.wav'), wav);

await runMigrations(url, resolve(backend, 'drizzle'));
const pepper = randomBytes(32);
const database = new pg.Pool({ connectionString: url });

try {
  const users = [];

  for (const [login, name] of [
    ['anna', 'Анна Смирнова'],
    ['maxim', 'Максим Волков'],
    ['elena', 'Елена Соколова'],
  ]) {
    const password = await hashPassword('gchat-web-test-password', pepper);
    const result = await database.query(
      `INSERT INTO gchat_users(login,display_name,password_hash) VALUES($1,$2,$3) ON CONFLICT(login) DO UPDATE SET display_name=excluded.display_name,password_hash=excluded.password_hash,disabled_at=null RETURNING id`,
      [login, name, password],
    );

    users.push(result.rows[0].id);
  }

  const group =
    (await database.query("SELECT id FROM gchat_groups WHERE name='близкие' ORDER BY id LIMIT 1"))
      .rows[0]?.id ??
    (await database.query("INSERT INTO gchat_groups(name) VALUES('близкие') RETURNING id")).rows[0]
      .id;

  for (const id of users)
    await database.query(
      'INSERT INTO gchat_group_members(group_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
      [group, id],
    );
} finally {
  await database.end();
}

const jwt = generateKeyPairSync('ed25519');
const apns = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const apnsPath = resolve(local, 'test-apns.p8');

await writeFile(apnsPath, apns.privateKey.export({ type: 'pkcs8', format: 'pem' }), {
  mode: 0o600,
});
await writeFile(
  resolve(local, 'backend.json'),
  JSON.stringify({
    HOST: '127.0.0.1',
    PORT: '3300',
    DATABASE_URL: url,
    REDIS_URL: 'redis://127.0.0.1:56389/0',
    REDIS_KEY_PREFIX: 'gchat:web-test:',
    AUTH_PASSWORD_PEPPER: pepper.toString('base64'),
    DIALOGS_ACTIVE_KEY_ID: 'e2e',
    DIALOGS_ENCRYPTION_KEYS: JSON.stringify({ e2e: randomBytes(32).toString('base64') }),
    AUTH_JWT_ACTIVE_KID: 'web-test',
    AUTH_JWT_PRIVATE_KEY: jwt.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    AUTH_JWT_PUBLIC_KEYS: JSON.stringify({
      'web-test': jwt.publicKey.export({ type: 'spki', format: 'pem' }),
    }),
    AUTH_ROTATION_ACTIVE_KID: 'web-test',
    AUTH_ROTATION_KEYS: JSON.stringify({ 'web-test': randomBytes(32).toString('base64') }),
    DIRECT_CALLS_TURN_URLS:
      '["turn:127.0.0.1:53479?transport=udp","turn:127.0.0.1:53479?transport=tcp"]',
    DIRECT_CALLS_TURN_SHARED_SECRET: 'gchat_web_test_turn_only',
    APNS_TEAM_ID: 'WEBTEST000',
    APNS_KEY_ID: 'WEBTEST000',
    APNS_BUNDLE_ID: 'invalid.gchat.web-test',
    APNS_ENVIRONMENT: 'sandbox',
    APNS_PRIVATE_KEY_FILE: apnsPath,
    SIGNALING_BROWSER_ORIGINS:
      '["http://127.0.0.1:5173","http://localhost:5173","http://127.0.0.1:5174"]',
  }),
  { mode: 0o600 },
);
console.log(
  'Web test fixtures ready. Accounts: anna, maxim, elena. Password: gchat-web-test-password.',
);
