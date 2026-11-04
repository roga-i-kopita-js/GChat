import type { JSX } from 'react';
import { useState } from 'react';
import { Link, Navigate, Outlet, Route, Routes, useLocation } from 'react-router';

import { type Credentials, CredentialsDialog } from '../features/administration/CredentialsDialog';
import { UsersPage } from '../features/administration/UsersPage';
import { AuthProvider, useAuth } from '../features/auth/AuthProvider';
import { LoginPage } from '../features/auth/LoginPage';
import { identity, readSession, saveSession } from '../features/auth/session';
import { CallsPage } from '../features/calls/CallsPage';
import { CallsProvider, useCalls } from '../features/calls/CallsProvider';
import { IncomingCall } from '../features/calls/IncomingCall';
import { AppLayout } from './AppLayout';

function RequireSession(): JSX.Element {
  const { session } = useAuth();
  const location = useLocation();

  return session ? (
    <Outlet />
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

function ApplicationRoutes(): JSX.Element {
  const { user } = useAuth();
  const { incoming } = useCalls();
  const [credentials, setCredentials] = useState<Credentials | null>(null);

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
                        setCredentials(value);
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
      {credentials && (
        <CredentialsDialog value={credentials} close={(): void => setCredentials(null)} />
      )}
    </>
  );
}

export function App(): JSX.Element {
  if (!('locks' in navigator) || !('mediaDevices' in navigator))
    return (
      <main className="unsupported">
        <h1>Откройте GChat в современном браузере</h1>
        <p>
          Для звонков нужны HTTPS, доступ к микрофону и поддержка Web Locks. Локальная разработка
          доступна на localhost.
        </p>
      </main>
    );

  return (
    <AuthProvider>
      <CallsProvider>
        <ApplicationRoutes />
        <IncomingCall />
      </CallsProvider>
    </AuthProvider>
  );
}
