import type { JSX, ReactNode } from 'react';
import { createContext, useContext, useEffect, useRef } from 'react';
import { useRevalidator } from 'react-router';

import type { ApplicationDevice } from '../../app/device';
import { SessionEvent } from '../../shared/device';
import { useDeviceState } from '../../shared/device/react';

type AuthState = {
  session: boolean;
  user: {
    sub: string;
    sid: string;
    login: string;
    display_name: string;
    role: 'user' | 'admin';
  } | null;
};
const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({
  device,
  children,
}: {
  device: ApplicationDevice;
  children: ReactNode;
}): JSX.Element {
  const revalidator = useRevalidator();
  const state = useDeviceState(device.session, SessionEvent.StateChanged);
  const generation = useRef(state.generation);

  useEffect(
    (): (() => void) =>
      device.session.on(SessionEvent.StateChanged, (next): void => {
        if (generation.current !== next.generation) {
          generation.current = next.generation;
          void revalidator.revalidate();
        }
      }),
    [device, revalidator.revalidate],
  );
  const user =
    state.identity && state.status === 'authenticated'
      ? {
          sub: state.identity.id,
          sid: String(state.generation),
          login: state.identity.login,
          display_name: state.identity.displayName,
          role: state.identity.role,
        }
      : null;

  return <AuthContext value={{ session: !!user, user }}>{children}</AuthContext>;
}

export function useAuth(): AuthState {
  const value = useContext(AuthContext);

  if (!value) {
    throw new Error('AuthProvider is required');
  }

  return value;
}
