import type { JSX } from 'react';

import { PermissionSettings } from './permission';
import { useSettingsDevice } from './useSettingsDevice';

export function SettingsCameraRoute(): JSX.Element {
  const device = useSettingsDevice();

  return <PermissionSettings section="camera" device={device} />;
}
