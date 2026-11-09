import type { JSX } from 'react';

import { LayoutOverlaysProvider } from '../shared/device/LayoutOverlaysProvider';
import { AppShell } from './layout/AppShell';
import { LayoutProvider } from './layout/LayoutProvider';

export function AppLayout(): JSX.Element {
  return (
    <LayoutProvider>
      <LayoutOverlaysProvider>
        <AppShell />
      </LayoutOverlaysProvider>
    </LayoutProvider>
  );
}
