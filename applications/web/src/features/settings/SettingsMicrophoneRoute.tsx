import type { JSX } from 'react';

import { AudioTestStatus } from './AudioTestStatus';
import { PermissionSettings } from './permission';
import { Group, SettingsAction } from './ui';
import { useSettingsDevice } from './useSettingsDevice';

export function SettingsMicrophoneRoute(): JSX.Element {
  const device = useSettingsDevice();

  return (
    <PermissionSettings section="microphone" device={device}>
      <Group>
        <SettingsAction
          device={device}
          onClick={(): void => {
            void device.testAudio('microphone');
          }}
        >
          Проверить микрофон
        </SettingsAction>
      </Group>
      <AudioTestStatus device={device} section="microphone" />
    </PermissionSettings>
  );
}
