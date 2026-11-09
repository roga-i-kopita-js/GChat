import type { JSX } from 'react';
import { Link } from 'react-router';

import { SettingsScreen } from './ui';

export function SettingsMissingRoute(): JSX.Element {
  return (
    <SettingsScreen parent="/settings/general" title="Настройка не найдена">
      <p role="status">Настройка не найдена</p>
      <Link to="/settings/general">К основным настройкам</Link>
    </SettingsScreen>
  );
}
