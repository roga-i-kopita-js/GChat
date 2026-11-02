// Deterministic test configuration; never connect to a developer's database.
process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:5432/gchat_test';
process.env.HOST = '127.0.0.1';
process.env.PORT = '3000';

process.env.REDIS_URL = 'redis://127.0.0.1:6379/0';
process.env.REDIS_KEY_PREFIX = 'gchat:test:';

// Ephemeral signing material exists only in this test process.
const { generateKeyPairSync, randomBytes } = require('node:crypto');
const { privateKey, publicKey } = generateKeyPairSync('ed25519');

process.env.AUTH_JWT_ACTIVE_KID = 'test';
process.env.AUTH_JWT_PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' });
process.env.AUTH_JWT_PUBLIC_KEYS = JSON.stringify({
  test: publicKey.export({ type: 'spki', format: 'pem' }),
});
process.env.AUTH_ROTATION_ACTIVE_KID = 'test';
process.env.AUTH_ROTATION_KEYS = JSON.stringify({ test: randomBytes(32).toString('base64') });
