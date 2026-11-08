import { expect, it } from 'vitest';

import { AudioEvent, CallEvent, CameraEvent, type DeviceCore, SessionEvent } from './api';
import { useDeviceState } from './react';

function validateTypes(device: DeviceCore<{ ping(): Promise<number> }>): void {
  const session = useDeviceState(device.session, SessionEvent.StateChanged);
  const call = useDeviceState(device.calls, CallEvent.StateChanged);

  void session.generation;
  void call.control;
  device.audio.on(AudioEvent.VolumeChanged, (event): void => {
    const level: number | null = event.level;

    void level;
  });
  void device.session.run((http): Promise<number> => http.ping());
  // @ts-expect-error An event belongs to its service, including when its payload is otherwise similar.
  useDeviceState(device.calls, CameraEvent.StreamInterrupted);
  device.audio.on(AudioEvent.VolumeChanged, (event): void => {
    // @ts-expect-error Volume events do not contain a selected output.
    void event.output;
  });
  // @ts-expect-error Device does not expose the private command dispatcher.
  device.execute({ command: 'camera.open' });
  // @ts-expect-error Public session snapshots never expose refresh tokens.
  void session.refresh_token;
  // @ts-expect-error The injected client's type is preserved inside session.run.
  void device.session.run((http): Promise<number> => http.unknown());
}

it('keeps the public API type checks in the TypeScript compilation', (): void => {
  expect(typeof validateTypes).toBe('function');
});
