import { Headphones } from 'lucide-react';
import type { JSX } from 'react';

import { AudioTestStatus } from './AudioTestStatus';
import { descriptions, titles } from './labels';
import { Group, Row, SettingsAction, SettingsScreen } from './ui';
import { useSettingsDevice } from './useSettingsDevice';

export function SettingsAudioRoute(): JSX.Element {
  const device = useSettingsDevice();
  const { audio, run, setSoundAnswer } = device;
  const action = (label: string, onClick: () => void): JSX.Element => (
    <SettingsAction device={device} onClick={onClick}>
      {label}
    </SettingsAction>
  );

  return (
    <SettingsScreen parent="/settings/general" title={titles.audio} device={device}>
      <p className="settings-intro">{descriptions.audio}</p>
      <Group>
        <Row
          icon={Headphones}
          color="#ff9f0a"
          title="Аудиовыход"
          value={audio.output?.name ?? 'Системный выход'}
        />
        {action('Выбрать аудиовыход', (): void => {
          void run((): ReturnType<typeof device.api.audio.outputs.pick> =>
            device.api.audio.outputs.pick(),
          );
        })}
      </Group>
      <p className="settings-note">
        Если выбор недоступен, используется системный выход. Громкость меняется кнопками устройства.
      </p>
      <Group>
        {action('Проверить звук', (): void => {
          setSoundAnswer('');
          void device.testAudio('sound');
        })}
      </Group>
      <AudioTestStatus device={device} section="audio" />
    </SettingsScreen>
  );
}
