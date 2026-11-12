import { eq, sql } from 'drizzle-orm';

import type { DatabaseTransaction } from '../database/database.service.js';
import type { ErrorService } from '../error/error.service.js';
import { callHistory } from './call-history.schema.js';
import { directCalls } from './direct-calls.schema.js';

/** Copy SQL timestamps without losing microseconds through JavaScript Date. */
export async function archiveCall(
  tx: DatabaseTransaction,
  callId: string,
  error: ErrorService,
): Promise<void> {
  await tx.execute(sql`
    insert into ${callHistory} (call_id, caller_id, recipient_id, created_at, started_at, ended_at, end_reason, version)
    select id, caller_id, recipient_id, created_at, started_at, ended_at, end_reason, version
    from ${directCalls} where id = ${callId} and state = 'ended'
    on conflict (call_id) do nothing
  `);
  const [matching] = await tx
    .select({ id: callHistory.callId })
    .from(callHistory)
    .innerJoin(directCalls, eq(directCalls.id, callHistory.callId))
    .where(sql`${callHistory.callId} = ${callId} and
      (${callHistory.callerId}, ${callHistory.recipientId}, ${callHistory.createdAt},
       ${callHistory.startedAt}, ${callHistory.endedAt}, ${callHistory.endReason}, ${callHistory.version})
      is not distinct from
      (${directCalls.callerId}, ${directCalls.recipientId}, ${directCalls.createdAt},
       ${directCalls.startedAt}, ${directCalls.endedAt}, ${directCalls.endReason}, ${directCalls.version})`);

  if (!matching) {
    throw error.internal();
  }
}
