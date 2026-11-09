import type { JSX } from 'react';
import { createContext, useEffect, useRef, useState } from 'react';
import { Link, Navigate, Outlet, useLoaderData, useLocation } from 'react-router';

import { type Credentials, CredentialsDialog } from '../features/administration/CredentialsDialog';
import { AuthProvider, useAuth } from '../features/auth/AuthProvider';
import { CallsProvider } from '../features/calls/CallsProvider';
import { IncomingCall } from '../features/calls/IncomingCall';
import { LifecycleEvent, SessionEvent } from '../shared/device';
import { deviceInternals } from '../shared/device/internals';
import { DeviceCallCameraHost, useDevice, useDevicePresentation } from '../shared/device/react';
import { BootstrapProvider } from '../shared/dialogs/BootstrapProvider';
import { retainFrontendUpdate } from '../shared/frontend-update-lease';
import { NavigationProtectionRoot } from '../shared/navigation-protection';
import type { ApplicationLoaderData } from './loaders';
import { PwaUpdate } from './PwaUpdate';

export function RequireSession(): JSX.Element {
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

export function RequireAdmin(): JSX.Element {
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

export const CredentialsContext = createContext<{
  value: Credentials | null;
  show(value: Credentials, sid: string): void;
} | null>(null);

export function App(): JSX.Element {
  const { device, adminResults } = useLoaderData<ApplicationLoaderData>();
  const core = useDevice();
  const presentation = useDevicePresentation();
  const [credentials, setCredentials] = useState<{ value: Credentials; sid: string } | null>(null);

  const currentCredentials = useRef<{ value: Credentials; sid: string } | null>(null);
  const credentialLease = useRef<(() => void) | null>(null);
  const showCredentials = (value: Credentials, sid: string): void => {
    const lease = retainFrontendUpdate();

    credentialLease.current?.();
    credentialLease.current = lease.release;
    currentCredentials.current = { value, sid };
    setCredentials(currentCredentials.current);
  };
  const hideCredentials = (): void => {
    currentCredentials.current = null;
    credentialLease.current?.();
    credentialLease.current = null;
    setCredentials(null);
  };

  useEffect(
    (): (() => void) => (): void => {
      credentialLease.current?.();
      credentialLease.current = null;
      currentCredentials.current = null;
    },
    [],
  );
  useEffect(
    (): (() => void) =>
      adminResults.subscribe((value, sid): void => {
        if (document.visibilityState === 'visible') {
          showCredentials(value, sid);
        }

        if (!value.self) {
          return;
        }

        void (async () => {
          try {
            return await deviceInternals(core).confirmSessionRevoked(Number(sid));
          } catch (cause) {}
        })();
      }),
    [adminResults, core],
  );

  useEffect((): (() => void) => {
    const offVisibility = core.lifecycle.on(LifecycleEvent.VisibilityChanged, (state): void => {
      if (state.visibility === 'background') {
        hideCredentials();
      }
    });
    const offSession = core.session.on(SessionEvent.StateChanged, (state): void => {
      const value = currentCredentials.current;

      if (
        value &&
        ((state.status === 'starting' && !value.value.self) ||
          (state.status === 'authenticated' && String(state.generation) !== value.sid))
      ) {
        hideCredentials();
      }
    });

    return (): void => {
      offVisibility();
      offSession();
    };
  }, [core]);

  if (!presentation.supportedEnvironment) {
    return (
      <main className="unsupported">
        <h1>Откройте GChat в современном браузере</h1>
        <p>Для звонков нужны HTTPS, доступ к микрофону и поддержка Web Locks.</p>
      </main>
    );
  }

  const content = (
    <AuthProvider device={device}>
      <NavigationProtectionRoot session={device.session}>
        <BootstrapProvider>
          <CallsProvider>
            <div data-gchat-surface>
              <PwaUpdate />

              <Outlet />
              <IncomingCall />
            </div>
            <DeviceCallCameraHost />
          </CallsProvider>
        </BootstrapProvider>
      </NavigationProtectionRoot>
    </AuthProvider>
  );

  return (
    <>
      <CredentialsContext
        value={{
          value: credentials?.value ?? null,
          show: showCredentials,
        }}
      >
        {content}
      </CredentialsContext>
      {credentials && <CredentialsDialog value={credentials.value} close={hideCredentials} />}
    </>
  );
}
