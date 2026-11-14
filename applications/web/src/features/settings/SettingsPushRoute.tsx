import { Bell, Volume2 } from 'lucide-react';
import type { JSX } from 'react';

import { descriptions, permissionLabels, pushStatus, titles } from './labels';
import { Group, Row, SettingsAction, SettingsScreen } from './ui';
import { useSettingsDevice } from './useSettingsDevice';

export function SettingsPushRoute(): JSX.Element {
  const device = useSettingsDevice();
  const { state, run } = device;
  const pushLabel = pushStatus(state);
  const action = (label: string, onClick: () => void): JSX.Element => (
    <SettingsAction device={device} onClick={onClick}>
      {label}
    </SettingsAction>
  );

  return (
    <SettingsScreen parent="/settings/general" title={titles.push} device={device}>
      <p className="settings-intro">{descriptions.push}</p>
      <Group>
        <Row
          icon={Bell}
          title="Разрешение"
          value={state ? permissionLabels[state.push.permission] : 'Проверяем…'}
        />
        <Row icon={Volume2} title="Доставка" value={pushLabel} />
        {state?.push.delivery === 'unavailable'
          ? action('Открыть настройки', (): void => {
              void run((): ReturnType<typeof device.api.permissions.openSettings> =>
                device.api.permissions.openSettings(),
              );
            })
          : action(
              state?.push.delivery === 'enabled' ? 'Выключить push' : 'Включить push',
              (): void => {
                void run((): Promise<void> =>
                  state?.push.delivery === 'enabled'
                    ? device.api.notifications.disable()
                    : device.api.notifications.enable(),
                );
              },
            )}
      </Group>
      {state?.push.delivery === 'unavailable' && (
        <p className="settings-note">
          Push для входящих звонков пока недоступен в этой среде или не настроен на сервере.
          Исходящие звонки от этого не зависят.
        </p>
      )}
    </SettingsScreen>
  );
}
