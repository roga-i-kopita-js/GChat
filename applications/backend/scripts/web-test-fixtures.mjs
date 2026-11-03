import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as argon2 from 'argon2';
import pg from 'pg';

import { runMigrations } from '../dist/database/migrations.js';

// Dedicated, loopback-only Compose fixture. Never reads a developer's .env or DATABASE_URL.
const url = 'postgresql://gchat_web_test:gchat_web_test_only@127.0.0.1:55439/gchat_web_test';
const backend = fileURLToPath(new URL('..', import.meta.url));
const local = fileURLToPath(new URL('../../web/.local/', import.meta.url));

await mkdir(local, { recursive: true });
await runMigrations(url, resolve(backend, 'drizzle'));
const database = new pg.Pool({ connectionString: url });

try {
  const password = await argon2.hash('gchat-web-test-password');
  const users = [];

  for (const [login, name] of [
    ['anna', 'Анна Смирнова'],
    ['maxim', 'Максим Волков'],
    ['elena', 'Елена Соколова'],
  ]) {
    const result = await database.query(
      `INSERT INTO gchat_users(login,display_name,password_hash) VALUES($1,$2,$3) ON CONFLICT(login) DO UPDATE SET display_name=excluded.display_name,password_hash=excluded.password_hash,disabled_at=null RETURNING id`,
      [login, name, password],
    );

    users.push(result.rows[0].id);
  }

  const group =
    (await database.query("SELECT id FROM gchat_groups WHERE name='Близкие' ORDER BY id LIMIT 1"))
      .rows[0]?.id ??
    (await database.query("INSERT INTO gchat_groups(name) VALUES('Близкие') RETURNING id")).rows[0]
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
    SIGNALING_BROWSER_ORIGINS: '["http://127.0.0.1:5173","http://localhost:5173"]',
  }),
  { mode: 0o600 },
);
console.log(
  'Web test fixtures ready. Accounts: anna, maxim, elena. Password: gchat-web-test-password.',
);
