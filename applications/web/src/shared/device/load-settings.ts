import { AudioEvent, type DeviceCore } from './api';
import type { DeviceState } from './contract';
import { cancellable } from './events';
import { deviceInternals } from './internals';
import { stateCache } from './state-cache';

/** Loader entry point: refresh the existing observer, without creating another device model. */
export async function loadDeviceSettings(
  device: DeviceCore,
  signal: AbortSignal,
): Promise<DeviceState> {
  return cancellable(
    async (): Promise<DeviceState> => {
      signal.throwIfAborted();
      const [state] = await Promise.all([
        deviceInternals(device).observer.refresh(signal),
        stateCache(device.audio, AudioEvent.StateChanged).preload(),
      ]);

      signal.throwIfAborted();

      return state;
    },
    { signal },
    signal,
  );
}
