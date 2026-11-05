import { useQueryClient } from '@tanstack/react-query';
import type { JSX, ReactNode } from 'react';
import { createContext, useContext, useEffect, useState } from 'react';

import { currentSession, identity } from './session';

type AuthState = {
  session: boolean;
  user: ReturnType<typeof identity> | null;
};
const AuthContext = createContext<AuthState | null>(null);

function readAuth(): AuthState {
  const session = currentSession();

  return { session: !!session, user: session ? identity(session) : null };
}

export function AuthProvider({ children }: { children: ReactNode }): JSX.Element {
  const [state, setState] = useState(readAuth);
  const cache = useQueryClient();

  useEffect((): (() => void) => {
    let sid = state.user?.sid ?? null;
    const sync = (): void => {
      const next = readAuth();
      const nextSid = next.user?.sid ?? null;

      if (sid !== nextSid) cache.clear();

      sid = nextSid;
      setState(next);
    };

    window.addEventListener('gchat-session', sync);
    window.addEventListener('storage', sync);

    return (): void => {
      window.removeEventListener('gchat-session', sync);
      window.removeEventListener('storage', sync);
    };
  }, [cache]);

  return <AuthContext value={state}>{children}</AuthContext>;
}

export function useAuth(): AuthState {
  const value = useContext(AuthContext);

  if (!value) throw new Error('AuthProvider is required');

  return value;
}
