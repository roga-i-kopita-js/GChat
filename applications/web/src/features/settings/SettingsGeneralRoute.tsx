import { Bell, Camera, Folder, Headphones, LocateFixed, Mic } from 'lucide-react';
import type { JSX } from 'react';

import type { PermissionState, Resource } from '../../shared/device/contract';
import { permissionLabels, pushStatus } from './labels';
import { Group, Row, SettingsScreen } from './ui';
import { useSettingsDevice } from './useSettingsDevice';

export function SettingsGeneralRoute(): JSX.Element {
  const device = useSettingsDevice();
  const { state, audio } = device;
  const status = (key: Resource): string => {
    if (!state) {
      return 'Проверяем…';
    }

    if (key === 'microphone') {
      return permissionLabels[state[key].permission];
    }

    const labels: Record<PermissionState['permission'], string> = {
      granted: 'Разрешена',
      denied: 'Запрещена',
      restricted: 'Ограничена',
      limited: 'Ограничена',
      prompt: 'Не запрошена',
      unknown: 'Неизвестно',
    };

    return labels[state[key].permission];
  };
  const pushLabel = pushStatus(state);

  let fileAccessSummary;

  if (state) {
    if (state.files.retainedCount) {
      fileAccessSummary = String(state.files.retainedCount);
    } else {
      fileAccessSummary = 'Нет доступов';
    }
  } else {
    fileAccessSummary = 'Проверяем…';
  }

  return (
    <SettingsScreen parent="/settings" title="Основные" device={device}>
      <Group title="Звук">
        <Row
          icon={Mic}
          color="#ff5b63"
          title="Микрофон"
          value={status('microphone')}
          to="/settings/general/microphone"
        />
        <Row
          icon={Headphones}
          color="#ff9f0a"
          title="Динамики и звук"
          value={audio.output?.name ?? 'Системный выход'}
          to="/settings/general/audio"
        />
      </Group>
      <Group title="Уведомления">
        <Row
          icon={Bell}
          color="#ff453a"
          title="Push-уведомления"
          value={pushLabel}
          to="/settings/general/push"
        />
      </Group>
      <Group title="Разрешения устройства">
        <Row
          icon={Camera}
          color="#8e8e93"
          title="Камера"
          value={status('camera')}
          to="/settings/general/camera"
        />
        <Row
          icon={LocateFixed}
          color="#007aff"
          title="Геопозиция"
          value={status('geolocation')}
          to="/settings/general/geolocation"
        />
      </Group>
      <Group title="Файлы">
        <Row
          icon={Folder}
          color="#30b0c7"
          title="Файлы и папки"
          value={fileAccessSummary}
          to="/settings/general/files"
        />
      </Group>
      <p className="settings-note">
        Разрешения действуют на этом устройстве и не зависят от аккаунта. В браузере они задаются
        для сайта.
      </p>
    </SettingsScreen>
  );
}
