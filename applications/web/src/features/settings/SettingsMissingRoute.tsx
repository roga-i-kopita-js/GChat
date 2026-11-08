import type { JSX } from 'react';
import { Link } from 'react-router';

import { SettingsScreen } from './ui';

export function SettingsMissingRoute(): JSX.Element {
  return (
    <SettingsScreen title="Настройка не найдена">
      <Link to="/settings/general">К основным настройкам</Link>
    </SettingsScreen>
  );
}
