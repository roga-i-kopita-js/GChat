import type { JSX } from 'react';

import { useDevice, useDevicePresentation } from '../../shared/device/react';
import { useAuth } from '../auth/AuthProvider';
import { CallCardSlot } from './CallCardSlot';
import { useCalls } from './CallsProvider';
import { CallSurface } from './CallSurface';

export function IncomingCall(): JSX.Element | null {
  const device = useDevice();
  const presentation = useDevicePresentation();
  const { user } = useAuth();
  const { incoming } = useCalls();

  return presentation.callControls === 'application' && user && incoming ? (
    <CallSurface incoming>
      <CallCardSlot />
    </CallSurface>
  ) : null;
}
