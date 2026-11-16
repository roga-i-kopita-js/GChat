import { afterEach, describe, expect, it, vi } from 'vitest';

import { GChatClient } from '../../shared/calls/client';
import { DeviceAudio } from '../../shared/device/audio';
import type { DeviceBridge } from '../../shared/device/contract';
import type { NativeMedia } from '../../shared/device/media-native';
import type { DeviceObserver } from '../../shared/device/observer';

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
  it('switches the call and signal outputs within the selecting user gesture', async (): Promise<void> => {
    const client = fixture();
    const controller = new AbortController();
    let gesture = false;
    const select = vi.fn(async (): Promise<void> => {
      if (!gesture) {
        throw new DOMException('A user gesture is required', 'NotAllowedError');
      }
    });

    vi.stubGlobal('HTMLMediaElement', class {});
    HTMLMediaElement.prototype.setSinkId = select;
    vi.stubGlobal('navigator', {
      mediaDevices: {
        enumerateDevices: vi.fn(async (): Promise<object[]> => [
          { deviceId: 'headset', kind: 'audiooutput', label: 'Headset' },
        ]),
      },
    });
    client.audio = { setSinkId: select, pause: vi.fn() };
    client.contextOutput = { select };
    const audio = new DeviceAudio(
      {} as DeviceBridge,
      {} as DeviceObserver,
      {} as NativeMedia,
      client,
      () => controller.signal,
    );

    await audio.getState();
    gesture = true;
    const pending = audio.outputs.select('headset');

    gesture = false;
    await expect(pending).resolves.toBeUndefined();
    expect(select).toHaveBeenCalledTimes(2);
    const { output } = await audio.getState();

    expect(output?.id).toBe('headset');
    expect(client.getSnapshot().audioBlocked).toBe(false);
  });

  it('starts ringtone routing before waiting for playback activation', async (): Promise<void> => {
    const client = fixture();
    let gesture = true;
    const select = vi.fn(async (): Promise<void> => {
      if (!gesture) {
        throw new DOMException('A user gesture is required', 'NotAllowedError');
      }
    });

    client.outputId = 'headset';
    client.audioContext = { state: 'running' };
    client.contextOutput = { start: vi.fn(async (): Promise<void> => {}), select };
    const pending = client.enableRingtone();

    gesture = false;
    await pending;
    expect(select).toHaveBeenCalledWith('headset');
    expect(client.getSnapshot().audible).toBe(true);
  });

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
