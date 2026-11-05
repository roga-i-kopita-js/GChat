import type { JSX } from 'react';

import { embedded } from '../../shared/native/bridge';
import { useAuth } from '../auth/AuthProvider';
import { CallCard } from './CallCard';
import { useCalls } from './CallsProvider';
import { CallSurface } from './CallSurface';

export function IncomingCall(): JSX.Element | null {
  const { user } = useAuth();
  const { incoming } = useCalls();

  return !embedded && user && incoming ? (
    <CallSurface incoming>
      <CallCard />
    </CallSurface>
  ) : null;
}
