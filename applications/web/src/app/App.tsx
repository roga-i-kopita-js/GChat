import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { Link, Navigate, Outlet, Route, Routes, useLocation } from 'react-router';

import { type Credentials, CredentialsDialog } from '../features/administration/CredentialsDialog';
import { UsersPage } from '../features/administration/UsersPage';
import { AuthProvider, useAuth } from '../features/auth/AuthProvider';
import { LoginPage } from '../features/auth/LoginPage';
import { identity, readSession, saveSession } from '../features/auth/session';
import { CallsPage } from '../features/calls/CallsPage';
import { CallsProvider, useCalls } from '../features/calls/CallsProvider';
import { IncomingCall } from '../features/calls/IncomingCall';
import { embedded } from '../shared/native/bridge';
import { nativeRuntime } from '../shared/native/runtime';
import { AppLayout } from './AppLayout';
import { NativeBoundary } from './NativeBoundary';
import { PwaUpdate } from './PwaUpdate';

function RequireSession(): JSX.Element {
  const { session } = useAuth();
  const location = useLocation();

  return session ? (
    <Outlet />
  ) : embedded ? (
    <p role="status">Ожидаем входа в приложении…</p>
  ) : (
    <Navigate
      to="/login"
      replace
      state={{ from: location.pathname + location.search + location.hash }}
    />
  );
}

function RequireAdmin(): JSX.Element {
  const { user } = useAuth();

  return user?.role === 'admin' ? (
    <Outlet />
  ) : (
    <section className="list-empty">
      <h2>Доступ запрещён</h2>
      <p>Требуются права администратора.</p>
      <Link className="secondary" to="/calls">
        К звонкам
      </Link>
    </section>
  );
}

function ApplicationRoutes({
  credentials,
  onCredentials,
}: {
  credentials: Credentials | null;
  onCredentials(value: Credentials, sid: string): void;
}): JSX.Element {
  const { user } = useAuth();
  const { incoming } = useCalls();

  return (
    <>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route element={<RequireSession />}>
          <Route element={<AppLayout />}>
            <Route index element={<Navigate to="/calls" replace />} />
            <Route path="calls" element={<CallsPage />} />
            <Route path="admin" element={<RequireAdmin />}>
              <Route index element={<Navigate to="users" replace />} />
              <Route
                path="users"
                element={
                  user && (
                    <UsersPage
                      key={user.sid}
                      userId={user.sub}
                      showDetails={!credentials && !incoming}
                      onCredentials={(value): void => {
                        onCredentials(value, user.sid);

                        if (embedded) {
                          if (value.self) void nativeRuntime.ready();

                          return;
                        }

                        const current = readSession();

                        if (value.self && current && identity(current).sid === user.sid)
                          saveSession(null);
                      }}
                    />
                  )
                }
              >
                <Route path=":userId" element={null} />
              </Route>
            </Route>
          </Route>
        </Route>
        <Route
          path="*"
          element={
            <main className="list-empty">
              <h1>Страница не найдена</h1>
              <Link className="primary" to="/calls">
                К звонкам
              </Link>
            </main>
          }
        />
      </Routes>
    </>
  );
}

export function App(): JSX.Element {
  const [credentials, setCredentials] = useState<{ value: Credentials; sid: string } | null>(null);

  // A one-time self-reset result must survive confirmed revocation, as in the browser UI.
  // Other account data is discarded on resync, and all credentials are hidden on backgrounding.
  useEffect((): (() => void) | undefined => {
    if (!embedded || !credentials) return;

    const sync = (): void => {
      const state = nativeRuntime.getSnapshot();
      const token = nativeRuntime.getToken();

      if (
        (state.phase !== 'ready' && !credentials.value.self) ||
        (token && identity({ access_token: token }).sid !== credentials.sid)
      )
        setCredentials(null);
    };
    const visibility = (): void => {
      if (document.visibilityState !== 'visible') setCredentials(null);
    };
    const unsubscribe = nativeRuntime.subscribe(sync);

    document.addEventListener('visibilitychange', visibility);

    return (): void => {
      unsubscribe();
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [credentials]);

  if (!embedded && (!('locks' in navigator) || !('mediaDevices' in navigator)))
    return (
      <main className="unsupported">
        <h1>Откройте GChat в современном браузере</h1>
        <p>
          Для звонков нужны HTTPS, доступ к микрофону и поддержка Web Locks. Локальная разработка
          доступна на localhost.
        </p>
      </main>
    );

  const content = (
    <AuthProvider>
      <PwaUpdate />
      <CallsProvider>
        <ApplicationRoutes
          credentials={credentials?.value ?? null}
          onCredentials={(value, sid): void => setCredentials({ value, sid })}
        />
        <IncomingCall />
      </CallsProvider>
    </AuthProvider>
  );

  return (
    <>
      {embedded ? <NativeBoundary>{content}</NativeBoundary> : content}
      {credentials && (
        <CredentialsDialog value={credentials.value} close={(): void => setCredentials(null)} />
      )}
    </>
  );
}
