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

export type Call = z.infer<typeof callSchema>;

export const callResponse = z.object({ call: callSchema });

export const currentResponse = z.object({ call: callSchema.nullable() });

export const pingResponse = z.object({
  state: callSchema.shape.state,
  version: z.number().int(),
  recovery_id: z.string().nullable(),
  recovery_deadline: z.string().nullable(),
});

export const iceConfig = z.object({
  ice_servers: z.array(
    z.object({ urls: z.array(z.string()), username: z.string(), credential: z.string() }),
  ),
  expires_at: z.string(),
});

export type { GroupDto as Group, GroupMemberDto as Member } from '@gchat/backend-api';

export const wireSchema = z.object({
  type: z.string(),
  request_id: z.string().optional(),
  payload: z.unknown().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});

export const sdpMessage = z.object({
  call_id: z.string(),
  negotiation_id: z.string(),
  sdp: z.string(),
});

export const iceMessage = z.object({
  call_id: z.string(),
  negotiation_id: z.string(),
  candidate: z
    .object({
      candidate: z.string(),
      sdp_mid: z.string().nullable(),
      sdp_mline_index: z.number().nullable(),
    })
    .nullable(),
});

/** Same-version full DTO is allowed after a compact ping response. */
export function mergeCall(previous: Call | null, next: Call): Call {
  if (!previous || previous.call_id !== next.call_id || next.version >= previous.version)
    return next;

  return previous;
}

export const reasons: Record<string, string> = {
  cancelled: 'Вызов отменён',
  rejected: 'Вызов отклонён',
  no_answer: 'Нет ответа',
  connection_timeout: 'Не удалось соединиться',
  hangup: 'Разговор завершён',
  connection_lost: 'Соединение потеряно',
  session_revoked: 'Сессия завершена',
  account_disabled: 'Аккаунт отключён',
};
