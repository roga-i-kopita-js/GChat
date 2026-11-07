import { afterEach, describe, expect, it, vi } from 'vitest';

import { GChatClient } from './client';

vi.mock('../../shared/runtime/transport', (): object => ({
  browserTransport: {
    send: vi.fn(async (): Promise<object> => ({ call: null })),
    isUpdating: (): boolean => false,
    changed: (): void => {},
  },
}));
vi.mock('../auth/session', (): object => ({
  readSession: vi.fn(),
  identity: vi.fn(),
  logout: vi.fn(),
  saveSession: vi.fn(),
}));

afterEach((): void => {
  vi.unstubAllGlobals();
});

function fixture(): any {
  const client: any = new GChatClient();

  client.state = { ...client.getSnapshot(), owner: true, connection: 'online' };

  return client;
}

describe('call audio integration', (): void => {
  it.each(['dial', 'accept'])(
    'does not send %s when microphone access is denied',
    async (action): Promise<void> => {
      const client = fixture();

      client.state.call = action === 'accept' ? { call_id: 'incoming', state: 'ringing' } : null;
      vi.stubGlobal('navigator', {
        mediaDevices: {
          getUserMedia: vi.fn(async (): Promise<never> => {
            throw new DOMException('Denied', 'NotAllowedError');
          }),
        },
      });
      await client[action]('recipient');
      expect(
        client.transport.send.mock.calls.every(
          ([name]: [string]): boolean => name === 'call.current',
        ),
      ).toBe(true);
      expect(client.getSnapshot().error).toContain('Доступ заблокирован');
    },
  );

  it('cancels pending preparation immediately when a call arrives', async (): Promise<void> => {
    const client = fixture();
    const stop = vi.fn();
    let grant!: (stream: object) => void;

    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: (): Promise<object> =>
          new Promise((resolve): void => {
            grant = resolve;
          }),
      },
    });
    const pending = client.audioPreparation.microphone();

    client.set({ call: { state: 'ringing' } });
    grant({ getTracks: (): object[] => [{ stop }] });
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(stop).toHaveBeenCalledOnce();
  });
});
