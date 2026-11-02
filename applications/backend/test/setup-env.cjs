// Deterministic test configuration; never connect to a developer's database.
process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:5432/gchat_test';
process.env.HOST = '127.0.0.1';
process.env.PORT = '3000';

process.env.REDIS_URL = 'redis://127.0.0.1:6379/0';
process.env.REDIS_KEY_PREFIX = 'gchat:test:';
