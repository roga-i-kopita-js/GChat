import { Check, X } from 'lucide-react';
import type { JSX } from 'react';

import { DeviceError } from '../../shared/device/contract';
import { deviceErrorMessage } from '../../shared/device/messages';
import { Button } from '../../shared/ui';
import { useCalls } from '../calls/CallsProvider';
import { Group } from './ui';
import type { SettingsDevice } from './useSettingsDevice';

export function AudioTestStatus({
  device,
  section,
}: {
  device: SettingsDevice;
  section: 'audio' | 'microphone';
}): JSX.Element {
  const { ongoing } = useCalls();
  const { state, soundAnswer, setSoundAnswer } = device;
  const test = state?.audio.test;

  return (
    <>
      {test?.status === 'running' && (
        <Group>
          <Button
            variant="ghost"
            className="settings-action"
            onClick={(): void => device.stopAudioTest()}
          >
            Остановить тест
          </Button>
          <p className="settings-test-status" role="status">
            {test.kind === 'sound' ? 'Воспроизводим сигнал…' : 'Проверяем микрофон…'}
          </p>
        </Group>
      )}
      {test?.status === 'failed' && (
        <p role="status" className="settings-note">
          {deviceErrorMessage(new DeviceError(test.errorCode ?? 'DEVICE_UNAVAILABLE'))}
        </p>
      )}
      {test?.status === 'completed' && test.kind === 'microphone' && section === 'microphone' && (
        <p className="settings-note" role="status">
          Микрофон доступен. Проверка завершена.
        </p>
      )}
      {test?.status === 'completed' && test.kind === 'sound' && section === 'audio' && (
        <Group>
          <p className="settings-test-status">Вы слышали сигнал?</p>
          <div className="settings-answers">
            <button onClick={(): void => setSoundAnswer('Слышимость подтверждена вами.')}>
              <Check size={17} /> Слышу
            </button>
            <button
              onClick={(): void =>
                setSoundAnswer('Проверьте громкость устройства и подключённую гарнитуру.')
              }
            >
              <X size={17} /> Не слышу
            </button>
          </div>
        </Group>
      )}
      {soundAnswer && (
        <p className="settings-note" role="status">
          {soundAnswer}
        </p>
      )}
      {ongoing && <p className="settings-note">Проверки доступны после завершения звонка.</p>}
    </>
  );
}
