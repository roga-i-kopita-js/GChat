import { afterEach, expect, it, vi } from 'vitest';

import { GChatClient } from '../../shared/calls/client';

vi.mock('../../shared/runtime/transport', (): object => ({
  browserTransport: { isUpdating: (): boolean => false, changed: (): void => {} },
}));
vi.mock('../../shared/session/session', (): object => ({
  readSession: (): object => ({}),
  identity: (): object => ({ sub: 'caller', sid: 'session' }),
  logout: vi.fn(),
}));

afterEach((): void => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each([false, true])(
  'sends a new offer on consecutive calls without dismissing the ended card (early event: %s)',
  async (earlyEvent): Promise<void> => {
    vi.useFakeTimers();
    const storage = new Map<string, string>();

    vi.stubGlobal('localStorage', {
      getItem: (key: string): string | null => storage.get(key) ?? null,
      setItem: (key: string, value: string): void => {
        storage.set(key, value);
      },
      removeItem: (key: string): void => {
        storage.delete(key);
      },
    });
    const stops = [vi.fn(), vi.fn()];
    let captures = 0;

    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: async (): Promise<object> => {
          const stop = stops[captures++];

          return { getTracks: (): object[] => [{ stop }] };
        },
      },
    });
    vi.stubGlobal(
      'Audio',
      class {
        pause(): void {}
      },
    );
    vi.stubGlobal(
      'RTCPeerConnection',
      class {
        connectionState = 'new';
        signalingState = 'stable';
        localDescription: object | null = null;

        addTrack(): void {}

        async createOffer(): Promise<object> {
          return { type: 'offer', sdp: 'test-offer' };
        }

        async setLocalDescription(value: object): Promise<void> {
          this.localDescription = value;
        }

        close(): void {}
      },
    );
    const client: any = new GChatClient();

    client.state = { ...client.getSnapshot(), owner: true, connection: 'online' };
    let call: any;
    const send = vi.fn(async (type: string): Promise<object> => {
      if (type === 'call.create') {
        call = {
          call_id: crypto.randomUUID(),
          state: 'ringing',
          version: 1,
          caller_id: 'caller',
          recipient_id: 'recipient',
          created_at: new Date().toISOString(),
          started_at: null,
          ended_at: null,
          end_reason: null,
          recovery_id: null,
          recovery_deadline: null,
          ringing_deadline: null,
          connecting_deadline: null,
        };

        if (earlyEvent) {
          await client.update(call);
        }

        return { call };
      }

      if (type === 'call.ice_config') {
        return { ice_servers: [], expires_at: new Date(Date.now() + 3600000).toISOString() };
      }

      if (type === 'call.ping') {
        return {
          state: call.state,
          version: call.version,
          recovery_id: null,
          recovery_deadline: null,
        };
      }

      if (type === 'call.end') {
        call = {
          ...call,
          state: 'ended',
          version: 3,
          end_reason: 'hangup',
          ended_at: new Date().toISOString(),
        };

        return { call };
      }

      return {};
    });

    client.transport = { send, isUpdating: (): boolean => false, changed: (): void => {} };

    try {
      for (let index = 0; index < 2; index++) {
        await client.dial('recipient');
        call = { ...call, state: 'connecting', version: 2 };
        await client.update(call);
        await client.mediaQueue;
        expect(send).toHaveBeenCalledWith(
          'rtc.offer',
          expect.objectContaining({ call_id: call.call_id }),
        );
        expect(stops[index]).not.toHaveBeenCalled();
        await client.end();
        expect(stops[index]).toHaveBeenCalledOnce();
        expect(client.getSnapshot().call.state).toBe('ended');
      }

      expect(captures).toBe(2);
    } finally {
      client.disposeMedia();
    }
  },
);
