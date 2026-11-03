import { describe, expect, it } from 'vitest';

import { callSchema, mergeCall } from './protocol';

const call = callSchema.parse({
  call_id: '7b8b5b26-929c-4c11-a0ba-902bb7947853',
  state: 'active',
  caller_id: 'caller',
  recipient_id: 'recipient',
  created_at: '2026-11-04T00:00:00.000Z',
  started_at: '2026-11-04T00:00:01.000Z',
  ended_at: null,
  end_reason: null,
  recovery_id: null,
  recovery_deadline: null,
  ringing_deadline: null,
  connecting_deadline: null,
  version: 4,
});

describe('call state versions', (): void => {
  it('does not let a delayed state replace a newer recovery window', (): void => {
    const current = {
      ...call,
      version: 6,
      recovery_id: 'window',
      recovery_deadline: '2026-11-04T00:01:00.000Z',
    };

    expect(mergeCall(current, call)).toBe(current);
  });
  it('fills a full DTO of the version already observed in a compact ping', (): void => {
    expect(mergeCall({ ...call, started_at: null }, call).started_at).toBe(call.started_at);
  });
  it('treats versions as local to one call', (): void => {
    const next = { ...call, call_id: '4d848aa5-c83f-4c92-b88b-783cba51ed4a', version: 0 };

    expect(mergeCall(call, next)).toEqual(next);
  });
});
