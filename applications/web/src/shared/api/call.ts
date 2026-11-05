import { z } from 'zod';

export const callSchema = z.object({
  call_id: z.string().uuid(),
  state: z.enum(['ringing', 'connecting', 'active', 'ended']),
  caller_id: z.string(),
  recipient_id: z.string(),
  created_at: z.string(),
  started_at: z.string().nullable(),
  ended_at: z.string().nullable(),
  end_reason: z.string().nullable(),
  recovery_id: z.string().nullable(),
  recovery_deadline: z.string().nullable(),
  ringing_deadline: z.string().nullable(),
  connecting_deadline: z.string().nullable(),
  version: z.number().int().nonnegative(),
});
