import { type LucideIcon, MessageCircle, Phone, Settings, ShieldCheck } from 'lucide-react';

export type LayoutSection = 'calls' | 'dialogs' | 'settings' | 'admin';

export interface LayoutRouteHandle {
  layout: {
    section: LayoutSection;
    scroll: 'page' | 'contained';
    navigation: 'visible' | 'hidden';
  };
}

export interface LayoutNavigationItem {
  section: LayoutSection;
  to: string;
  label: string;
  icon: LucideIcon;
  adminOnly?: boolean;
}

export const layoutNavigation: LayoutNavigationItem[] = [
  { section: 'calls', to: '/calls', label: 'Звонки', icon: Phone },
  { section: 'dialogs', to: '/dialogs', label: 'Диалоги', icon: MessageCircle },
  {
    section: 'admin',
    to: '/admin/users',
    label: 'Администрирование',
    icon: ShieldCheck,
    adminOnly: true,
  },
  { section: 'settings', to: '/settings', label: 'Настройки', icon: Settings },
];

export function layoutRoute(
  section: LayoutSection,
  scroll: 'page' | 'contained' = 'page',
  navigation: 'visible' | 'hidden' = 'visible',
): LayoutRouteHandle {
  return { layout: { section, scroll, navigation } };
}

export function isLayoutRouteHandle(value: unknown): value is LayoutRouteHandle {
  if (!value || typeof value !== 'object' || !('layout' in value)) {
    return false;
  }

  const layout = value.layout;

  return (
    !!layout &&
    typeof layout === 'object' &&
    'section' in layout &&
    layoutNavigation.some((item): boolean => item.section === layout.section) &&
    'scroll' in layout &&
    (layout.scroll === 'page' || layout.scroll === 'contained') &&
    'navigation' in layout &&
    (layout.navigation === 'visible' || layout.navigation === 'hidden')
  );
}
