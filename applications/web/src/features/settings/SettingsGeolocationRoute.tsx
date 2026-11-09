import type { JSX } from 'react';

import { PermissionSettings } from './permission';
import { useSettingsDevice } from './useSettingsDevice';

export function SettingsGeolocationRoute(): JSX.Element {
  const device = useSettingsDevice();
  const { state } = device;

  let accuracyDescription;

  if (state?.geolocation.accuracy === 'full') {
    accuracyDescription = 'точная';
  } else if (state?.geolocation.accuracy === 'reduced') {
    accuracyDescription = 'приблизительная';
  } else {
    accuracyDescription = 'неизвестна';
  }

  return (
    <PermissionSettings section="geolocation" device={device}>
      <p className="settings-note">
        Точность: {accuracyDescription}.{' '}
        {state?.geolocation.service === 'disabled'
          ? 'Геопозиция отключена в системе.'
          : 'Фоновое отслеживание не используется.'}
      </p>
    </PermissionSettings>
  );
}
