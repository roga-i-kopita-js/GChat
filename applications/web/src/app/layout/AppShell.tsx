import type { JSX } from 'react';
import { Outlet } from 'react-router';

import { PageContent, PageSurface } from '../../shared/ui';
import { RoutePending } from '../RoutePending';
import { BottomNavigation } from './BottomNavigation';
import { CallNotices } from './CallNotices';
import { CallReturnBanner } from './CallReturnBanner';
import { DiagnosticsTrigger } from './DiagnosticsTrigger';
import { LayoutOverlays } from './LayoutOverlays';
import { useLayout } from './LayoutProvider';
import { LayoutViewport } from './LayoutViewport';

export function AppShell(): JSX.Element {
  const { section, label, contained, native } = useLayout();

  return (
    <div className={'app-shell' + (native ? ' app-shell-native' : '')}>
      <RoutePending />
      <CallReturnBanner />
      <LayoutViewport>
        <PageContent
          contained={contained}
          className={'workspace ' + section + '-active'}
          aria-label={label}
        >
          <CallNotices />
          <PageSurface>
            <Outlet />
          </PageSurface>
          <DiagnosticsTrigger />
        </PageContent>
      </LayoutViewport>
      <BottomNavigation />
      <LayoutOverlays />
    </div>
  );
}
