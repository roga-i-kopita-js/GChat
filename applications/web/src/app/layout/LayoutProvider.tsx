import type { JSX, ReactNode } from 'react';
import { createContext, useContext } from 'react';
import { useMatches } from 'react-router';

import { useAuth } from '../../features/auth/AuthProvider';
import { useDevicePresentation } from '../../shared/device/react';
import {
  isLayoutRouteHandle,
  layoutNavigation,
  type LayoutNavigationItem,
  type LayoutSection,
} from './sections';

interface LayoutState {
  section: LayoutSection;
  label: string;
  contained: boolean;
  native: boolean;
  callNotices: boolean;
  navigation: LayoutNavigationItem[];
  showNavigation: boolean;
}

const LayoutContext = createContext<LayoutState | null>(null);

export function LayoutProvider({ children }: { children: ReactNode }): JSX.Element | null {
  const matches = useMatches();
  const { user } = useAuth();
  const presentation = useDevicePresentation();
  const handle = matches.map((match): unknown => match.handle).findLast(isLayoutRouteHandle);

  if (!user) {
    return null;
  }

  if (!handle) {
    throw new Error('Layout route metadata is required');
  }

  const section = handle.layout.section;
  const navigation = layoutNavigation.filter(
    (item): boolean => !item.adminOnly || user.role === 'admin',
  );
  const label = layoutNavigation.find((item): boolean => item.section === section)!.label;

  return (
    <LayoutContext
      value={{
        section,
        label,
        navigation,
        showNavigation: handle.layout.navigation === 'visible',
        contained: handle.layout.scroll === 'contained',
        native: presentation.loginNavigation === 'host',
        callNotices: section === 'calls' || section === 'admin',
      }}
    >
      {children}
    </LayoutContext>
  );
}

export function useLayout(): LayoutState {
  const value = useContext(LayoutContext);

  if (!value) {
    throw new Error('LayoutProvider is required');
  }

  return value;
}
