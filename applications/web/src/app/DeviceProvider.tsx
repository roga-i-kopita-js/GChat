import type { JSX, ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';

import { useAuth } from '../features/auth/AuthProvider';
import { useCalls } from '../features/calls/CallsProvider';
import { CommandBridge } from '../shared/device/bridge';
import { DeviceContext } from '../shared/device/context';
import { DeviceError } from '../shared/device/contract';

export function DeviceProvider({ children }: { children: ReactNode }): JSX.Element {
  const { user } = useAuth();
  const calls = useCalls();
  const current = useRef({ user, calls });

  current.current = { user, calls };
  const [bridge] = useState(
    (): CommandBridge =>
      new CommandBridge({
        current: (): boolean => !!current.current.user,
        audioAllowed: (): boolean =>
          !!current.current.user &&
          current.current.calls.state.owner &&
          !current.current.calls.state.busy &&
          !current.current.calls.ongoing,
        stopAudio: (): void => current.current.calls.client.audioPreparation?.stop(),
        testMicrophone: (): Promise<void> => {
          const preparation = current.current.calls.client.audioPreparation;

          if (!preparation) return Promise.reject(new DeviceError('UNSUPPORTED'));

          return preparation.microphone();
        },
        testSound: (): Promise<void> =>
          current.current.calls.client.testSound?.() ??
          Promise.reject(new DeviceError('UNSUPPORTED')),
        setOutput: (id): Promise<void> =>
          current.current.calls.client.setAudioOutput?.(id) ??
          Promise.reject(new DeviceError('UNSUPPORTED')),
        pushOnline: (): boolean =>
          !!current.current.user &&
          current.current.calls.state.owner &&
          current.current.calls.state.connection === 'online',
        push: (type, payload): Promise<unknown> =>
          current.current.calls.client.webPush?.(type, payload) ??
          Promise.reject(new DeviceError('UNSUPPORTED')),
      }),
  );

  const previousSession = useRef(user?.sid);

  useEffect((): void => {
    if (previousSession.current !== user?.sid) {
      previousSession.current = user?.sid;
      bridge.reset();
    }
  }, [bridge, user?.sid]);
  useEffect((): (() => void) => (): void => bridge.reset(), [bridge]);
  useEffect((): void => {
    if (calls.ongoing || !calls.state.owner) bridge.stopAudio();
  }, [bridge, calls.ongoing, calls.state.owner]);

  return <DeviceContext value={bridge}>{children}</DeviceContext>;
}
