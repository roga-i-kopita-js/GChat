import pg from 'pg';
import { createClient } from 'redis';

// Same dedicated fixture as tests/e2e/compose.yml; no configurable production target.
const database = new pg.Pool({
  connectionString:
    'postgresql://gchat_web_test:gchat_web_test_only@127.0.0.1:55439/gchat_web_test',
});
const redis = createClient({ url: 'redis://127.0.0.1:56389/0' });

try {
  await database.query('DELETE FROM gchat_direct_calls');
  await redis.connect();

  for await (const keys of redis.scanIterator({ MATCH: 'gchat:web-test:direct-calls:*' })) {
    if (keys.length) {
      await redis.del(keys);
    }
  }
} finally {
  if (redis.isOpen) {
    await redis.close();
  }

  await database.end();
}
