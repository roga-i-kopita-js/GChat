import { useQueryClient } from '@tanstack/react-query';
import type { JSX, ReactNode } from 'react';
import { createContext, useContext, useEffect, useState } from 'react';

import { identity, readSession, type Session } from './session';

type AuthState = { session: Session | null; user: ReturnType<typeof identity> | null };
const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }): JSX.Element {
  const [session, setSession] = useState(readSession);
  const cache = useQueryClient();

  useEffect((): (() => void) => {
    let sid = session ? identity(session).sid : null;
    const sync = (): void => {
      const next = readSession();
      const nextSid = next ? identity(next).sid : null;

      if (sid !== nextSid) cache.clear();

      sid = nextSid;
      setSession(next);
    };

    window.addEventListener('gchat-session', sync);
    window.addEventListener('storage', sync);

    return (): void => {
      window.removeEventListener('gchat-session', sync);
      window.removeEventListener('storage', sync);
    };
  }, [cache]);

  return (
    <AuthContext value={{ session, user: session ? identity(session) : null }}>
      {children}
    </AuthContext>
  );
}

export function useAuth(): AuthState {
  const value = useContext(AuthContext);

  if (!value) throw new Error('AuthProvider is required');

  return value;
}
