import { ShieldCheck } from 'lucide-react';
import type { JSX, ReactNode } from 'react';

import { descriptions, permissionLabels, titles } from './labels';
import { Group, Row, SettingsAction, SettingsScreen } from './ui';
import type { SettingsDevice } from './useSettingsDevice';

export function PermissionSettings({
  section,
  device,
  children,
}: {
  section: 'microphone' | 'camera' | 'geolocation';
  device: SettingsDevice;
  children?: ReactNode;
}): JSX.Element {
  const permission = device.state?.[section];
  const resource = section;
  const { run } = device;
  const action = (label: string, onClick: () => void): JSX.Element => (
    <SettingsAction device={device} onClick={onClick}>
      {label}
    </SettingsAction>
  );

  let permissionAction;

  if (
    permission &&
    (permission.permission === 'denied' || permission.permission === 'restricted')
  ) {
    permissionAction = action('Открыть настройки', (): void => {
      void run((): ReturnType<typeof device.api.permissions.openSettings> =>
        device.api.permissions.openSettings(),
      );
    });
  } else if (permission?.permission !== 'granted') {
    permissionAction = action('Разрешить доступ', (): void => {
      void run((): ReturnType<typeof device.api.permissions.request> =>
        device.api.permissions.request(resource),
      );
    });
  } else {
    permissionAction = null;
  }

  return (
    <SettingsScreen title={titles[section]} parent="/settings/general" device={device}>
      <p className="settings-intro">{descriptions[section]}</p>
      <Group>
        <Row
          icon={ShieldCheck}
          color="#34c759"
          title="Доступ"
          value={permission ? permissionLabels[permission.permission] : 'Проверяем…'}
        />
        {permissionAction}
      </Group>
      {permission?.settingsHint === 'siteSettings' &&
        (permission.permission === 'denied' || permission.permission === 'restricted') && (
          <p className="settings-note">
            Откройте разрешения сайта в меню браузера. После изменения вернитесь в GChat.
          </p>
        )}
      {children}
    </SettingsScreen>
  );
}
