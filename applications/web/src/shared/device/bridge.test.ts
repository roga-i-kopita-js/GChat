import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted((): { cycle: string; plugin: ReturnType<typeof vi.fn> } => ({
  cycle: '00000000-0000-4000-8000-000000000001',
  plugin: vi.fn(),
}));

vi.mock('../native/bridge', (): object => ({
  embedded: true,
  nativePlugin: { executeDeviceCommand: mock.plugin },
}));
vi.mock('../native/runtime', (): object => ({
  nativeRuntime: {
    getSnapshot: (): object => ({ phase: 'ready', cycleId: mock.cycle }),
    getToken: (): string => 'fixture-token',
  },
}));

import { CommandBridge } from './bridge';
import type { BrowserDeviceHost } from './browser';

const host: BrowserDeviceHost = {
  current: (): boolean => true,
  audioAllowed: (): boolean => true,
  stopAudio: (): void => {},
  testMicrophone: async (): Promise<void> => {},
  testSound: async (): Promise<void> => {},
  setOutput: async (): Promise<void> => {},
  pushOnline: (): boolean => false,
  push: async (): Promise<unknown> => ({}),
};

beforeEach((): void => {
  vi.resetAllMocks();
  mock.cycle = '00000000-0000-4000-8000-000000000001';
});
afterEach((): void => {
  vi.useRealTimers();
});
describe('native command transport', (): void => {
  it('validates input before native dispatch and never falls back to browser', async (): Promise<void> => {
    const bridge = new CommandBridge(host);

    await expect(
      bridge.execute({
        command: 'file.create',
        args: { directoryId: crypto.randomUUID(), name: '../private' },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(mock.plugin).not.toHaveBeenCalled();
    mock.plugin.mockRejectedValue({ code: 'BRIDGE_UNAVAILABLE' });
    await expect(
      bridge.execute({ command: 'permission.read', args: { resource: 'camera' } }),
    ).rejects.toMatchObject({ code: 'BRIDGE_UNAVAILABLE' });
  });
  it('rejects an uncorrelated reply and results from the previous web cycle', async (): Promise<void> => {
    const bridge = new CommandBridge(host);

    mock.plugin.mockImplementation(
      async (request: { cycleId: string; requestId: string }): Promise<unknown> => ({
        ...request,
        args: undefined,
        cycleId: '00000000-0000-4000-8000-000000000099',
        result: { permission: 'granted', settingsHint: 'appSettings' },
      }),
    );
    await expect(
      bridge.execute({ command: 'permission.read', args: { resource: 'camera' } }),
    ).rejects.toMatchObject({ code: 'INTEGRATION_ERROR' });
    mock.plugin.mockImplementation(
      async (request: { cycleId: string; requestId: string }): Promise<unknown> => {
        mock.cycle = crypto.randomUUID();

        return {
          deviceBridgeVersion: 1,
          cycleId: request.cycleId,
          requestId: request.requestId,
          result: { permission: 'granted', settingsHint: 'appSettings' },
        };
      },
    );
    await expect(
      bridge.execute({ command: 'permission.read', args: { resource: 'camera' } }),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
  });
  it('returns an unknown outcome for a timed-out mutation without resending it', async (): Promise<void> => {
    vi.useFakeTimers();
    mock.plugin.mockImplementation((): Promise<unknown> => new Promise((): void => {}));
    const bridge = new CommandBridge(host);
    const rejected = expect(
      bridge.execute({
        command: 'file.remove',
        args: { id: crypto.randomUUID(), recursive: false },
      }),
    ).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });

    await vi.advanceTimersByTimeAsync(30000);
    await rejected;
    expect(mock.plugin).toHaveBeenCalledOnce();
  });
});
