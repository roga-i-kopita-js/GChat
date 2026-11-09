import type { JSX } from 'react';
import { NavLink } from 'react-router';

import { useLayout } from './LayoutProvider';

export function BottomNavigation(): JSX.Element {
  const { navigation } = useLayout();

  return (
    <nav className="bottom-navigation" aria-label="Основные разделы">
      {navigation.map(({ to, label, icon: Icon }): JSX.Element => (
        <NavLink
          key={to}
          to={to}
          className={({ isActive }): string => 'bottom-tab' + (isActive ? ' active' : '')}
        >
          <Icon size={24} aria-hidden="true" />
          <span>{label}</span>
        </NavLink>
      ))}
    </nav>
  );
}
