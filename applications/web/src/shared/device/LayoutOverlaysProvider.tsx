import type { JSX, ReactNode } from 'react';
import { createContext, useContext, useEffect, useState } from 'react';

import { useDebug } from '../useDebug';
import { CallEvent, SessionEvent } from './api';
import { DeviceError } from './contract';
import { useDevice, useDevicePresentation, useDeviceState } from './react';

interface LayoutOverlaysState {
  diagnostics: boolean;
  diagnosticsAvailable: boolean;
  openDiagnostics(): void;
  closeDiagnostics(): void;
}

const LayoutOverlaysContext = createContext<LayoutOverlaysState | null>(null);

export function LayoutOverlaysProvider({ children }: { children: ReactNode }): JSX.Element {
  const device = useDevice();
  const presentation = useDevicePresentation();
  const session = useDeviceState(device.session, SessionEvent.StateChanged);
  const { call } = useDeviceState(device.calls, CallEvent.StateChanged);
  const debug = useDebug();
  const [diagnostics, setDiagnostics] = useState(false);
  const incoming = !!call && call.state === 'ringing' && call.recipient_id === session.identity?.id;
  const diagnosticsAvailable =
    debug &&
    presentation.callControls === 'application' &&
    session.status === 'authenticated' &&
    !incoming;

  useEffect((): void => {
    if (!diagnosticsAvailable) {
      setDiagnostics(false);
    }
  }, [diagnosticsAvailable]);

  return (
    <LayoutOverlaysContext
      value={{
        diagnostics: diagnosticsAvailable && diagnostics,
        diagnosticsAvailable,
        openDiagnostics: (): void => {
          if (diagnosticsAvailable) {
            setDiagnostics(true);
          }
        },
        closeDiagnostics: (): void => setDiagnostics(false),
      }}
    >
      {children}
    </LayoutOverlaysContext>
  );
}

export function useLayoutOverlays(): LayoutOverlaysState {
  const value = useContext(LayoutOverlaysContext);

  if (!value) {
    throw new DeviceError('INTEGRATION_ERROR');
  }

  return value;
}
