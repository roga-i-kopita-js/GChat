import pg from 'pg';
import { createClient } from 'redis';

// Read-only inspector with a fixed destination, never a developer/production DATABASE_URL.
const database = new pg.Pool({
  connectionString:
    'postgresql://gchat_web_test:gchat_web_test_only@127.0.0.1:55439/gchat_web_test',
});
const redis = createClient({ url: 'redis://127.0.0.1:56389/0' });

try {
  const calls = await database.query(
    'SELECT id, state, end_reason, version FROM gchat_direct_calls ORDER BY created_at',
  );
  const participants = await database.query(
    'SELECT call_id, role, device_id, connected_negotiation_id, released_at FROM gchat_direct_call_participants ORDER BY call_id, role',
  );

  await redis.connect();
  const busy = [];

  for await (const keys of redis.scanIterator({ MATCH: 'gchat:web-test:direct-calls:busy:*' })) {
    busy.push(...keys);
  }

  console.log(
    JSON.stringify({ calls: calls.rows, participants: participants.rows, busy: busy.length }),
  );
} finally {
  if (redis.isOpen) {
    await redis.close();
  }

  await database.end();
}
