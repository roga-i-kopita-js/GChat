import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BrowserDevice, type BrowserDeviceHost } from './browser';

let listeners: Record<string, () => void>;
let host: BrowserDeviceHost;
let stops: ReturnType<typeof vi.fn>;
let current = true;

function environment(permission: string): void {
  vi.stubGlobal('navigator', {
    permissions: {
      query: vi.fn(async (): Promise<unknown> => ({
        state: permission,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    },
    mediaDevices: {
      addEventListener: vi.fn(),
      getUserMedia: vi.fn(async (): Promise<unknown> => ({
        getTracks: (): unknown[] => [{ stop: stops }],
      })),
    },
  });
}
beforeEach((): void => {
  listeners = {};
  current = true;
  stops = vi.fn();
  vi.stubGlobal('document', {
    hidden: false,
    addEventListener: (name: string, handler: () => void): void => {
      listeners[name] = handler;
    },
  });
  vi.stubGlobal('window', { addEventListener: vi.fn() });
  environment('granted');
  host = {
    current: (): boolean => current,
    audioAllowed: (): boolean => true,
    stopAudio: vi.fn(),
    testMicrophone: vi.fn(async (): Promise<void> => {}),
    testSound: vi.fn(async (): Promise<void> => {}),
    setOutput: vi.fn(async (): Promise<void> => {}),
    pushOnline: (): boolean => false,
    push: vi.fn(async (): Promise<unknown> => ({})),
  };
});
afterEach((): void => {
  vi.unstubAllGlobals();
});
describe('browser device adapter', (): void => {
  it('a permission query does not open microphone, camera or location', async (): Promise<void> => {
    const device = new BrowserDevice(host);

    await device.execute('permission.read', { resource: 'camera' });
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  });
  it.each(['granted', 'denied'] as const)(
    'rereads microphone permission changed to %s without a change event',
    async (permission): Promise<void> => {
      environment('prompt');
      const device = new BrowserDevice(host);

      expect(await device.execute('permission.read', { resource: 'microphone' })).toEqual({
        permission: 'prompt',
        settingsHint: 'siteSettings',
      });
      environment(permission);
      expect(await device.execute('permission.read', { resource: 'microphone' })).toEqual({
        permission,
        settingsHint: 'siteSettings',
      });
      expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    },
  );
  it('rereads microphone permission after granting access', async (): Promise<void> => {
    environment('prompt');
    const device = new BrowserDevice(host);

    await device.execute('permission.read', { resource: 'microphone' });
    vi.mocked(navigator.mediaDevices.getUserMedia).mockImplementationOnce(
      async (): Promise<MediaStream> => {
        environment('granted');

        return { getTracks: (): unknown[] => [{ stop: stops }] } as unknown as MediaStream;
      },
    );
    await device.execute('permission.request', { resource: 'microphone' });
    expect(await device.execute('permission.read', { resource: 'microphone' })).toEqual({
      permission: 'granted',
      settingsHint: 'siteSettings',
    });
    expect(stops).toHaveBeenCalledOnce();
  });
  it('closes every camera track and returns only permission, not media', async (): Promise<void> => {
    const device = new BrowserDevice(host);

    expect(await device.execute('permission.request', { resource: 'camera' })).toEqual({
      outcome: 'completed',
      state: { permission: 'granted', settingsHint: 'siteSettings' },
    });
    expect(stops).toHaveBeenCalledOnce();
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({ audio: false, video: true });
  });
  it('disposes a late camera grant after logout without applying the result', async (): Promise<void> => {
    let release: (value: MediaStream) => void = (): void => {};

    vi.mocked(navigator.mediaDevices.getUserMedia).mockImplementation(
      (): Promise<MediaStream> =>
        new Promise((resolve): void => {
          release = resolve;
        }),
    );
    const device = new BrowserDevice(host);
    const pending = device.execute('permission.request', { resource: 'camera' });

    device.reset();
    current = false;
    release({ getTracks: (): unknown[] => [{ stop: stops }] } as unknown as MediaStream);
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(stops).toHaveBeenCalledOnce();
  });
  it('does not prepare an outgoing call when permission was denied', async (): Promise<void> => {
    environment('denied');
    const device = new BrowserDevice(host);

    await expect(device.execute('call.prepareOutgoing', {})).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  });
  it('refuses audio during a call without touching the microphone', async (): Promise<void> => {
    host.audioAllowed = (): boolean => false;
    const device = new BrowserDevice(host);

    await expect(device.execute('audio.test.start', { kind: 'sound' })).rejects.toMatchObject({
      code: 'BUSY',
    });
    expect(host.testSound).not.toHaveBeenCalled();
  });
});
