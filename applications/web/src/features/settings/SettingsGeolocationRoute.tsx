import type { JSX } from 'react';

import { PermissionSettings } from './permission';
import { useSettingsDevice } from './useSettingsDevice';

export function SettingsGeolocationRoute(): JSX.Element {
  const device = useSettingsDevice();
  const { state } = device;

  return (
    <PermissionSettings section="geolocation" device={device}>
      <p className="settings-note">
        Точность:{' '}
        {state?.geolocation.accuracy === 'full'
          ? 'точная'
          : state?.geolocation.accuracy === 'reduced'
            ? 'приблизительная'
            : 'неизвестна'}
        .{' '}
        {state?.geolocation.service === 'disabled'
          ? 'Геопозиция отключена в системе.'
          : 'Фоновое отслеживание не используется.'}
      </p>
    </PermissionSettings>
  );
}
