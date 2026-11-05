import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';

import { embedded } from '../../shared/native/bridge';
import { audioError, canSelectOutput } from './audio-preparation';
import { useCalls } from './CallsProvider';

export function AudioControls(): JSX.Element | null {
  const { client, state, ongoing } = useCalls();
  const [permission, setPermission] = useState<PermissionState | 'unknown'>('unknown');
  const [mic, setMic] = useState('');
  const [sound, setSound] = useState('Звук ещё не проверен.');
  const [busy, setBusy] = useState(false);
  const [tested, setTested] = useState(false);
  const [playing, setPlaying] = useState(false);
  const generation = useRef(0);
  const allowed = state.owner && !ongoing && !state.busy;
  const available = useRef(allowed);

  available.current = allowed;

  useEffect((): (() => void) => {
    const timer = playing ? setTimeout((): void => setPlaying(false), 1100) : undefined;

    return (): void => clearTimeout(timer);
  }, [playing]);

  useEffect((): (() => void) => {
    let stopped = false;
    let status: PermissionStatus | undefined;
    let request = 0;
    const update = (): void => {
      if (!stopped && status) {
        setPermission(status.state);
        setMic('');
      }
    };
    const refresh = async (): Promise<void> => {
      const current = ++request;

      setMic('');
      setTested(false);
      setSound('Звук ещё не проверен.');

      try {
        const next = await navigator.permissions.query({ name: 'microphone' });

        if (stopped || current !== request) return;

        status?.removeEventListener('change', update);
        status = next;
        status.addEventListener('change', update);
        update();
      } catch {
        if (!stopped && current === request) setPermission('unknown');
      }
    };
    const focus = (): void => {
      void refresh();
    };

    if (!embedded) {
      void refresh();
      window.addEventListener('focus', focus);
      navigator.mediaDevices?.addEventListener('devicechange', focus);
    }

    return (): void => {
      stopped = true;
      generation.current++;
      status?.removeEventListener('change', update);
      window.removeEventListener('focus', focus);
      navigator.mediaDevices?.removeEventListener('devicechange', focus);
      client.audioPreparation?.stop();
    };
  }, [client]);

  useEffect((): void => {
    if (!allowed) {
      generation.current++;
      client.audioPreparation?.stop();
      setBusy(false);
      setPlaying(false);
      setTested(false);
    }
  }, [allowed, client]);

  if (embedded || !client.audioPreparation) return null;

  async function run(kind: 'microphone' | 'sound' | 'output'): Promise<void> {
    if (!available.current || busy) return;

    const current = ++generation.current;

    setBusy(true);
    setTested(false);
    setPlaying(false);
    const valid = (): boolean => current === generation.current && available.current;

    try {
      if (kind === 'microphone') {
        await client.audioPreparation?.microphone();

        if (valid()) setMic('Захват звука доступен. Проверка завершена, микрофон освобождён.');
      } else if (kind === 'sound') {
        await client.testSound?.();

        if (valid()) {
          setSound('Воспроизведение доступно. Вы слышали сигнал?');
          setTested(true);
          setPlaying(true);
        }
      } else if (navigator.mediaDevices && canSelectOutput(navigator.mediaDevices)) {
        const output = await navigator.mediaDevices.selectAudioOutput();

        if (!valid()) return;

        await client.setAudioOutput?.(output.deviceId);

        if (valid()) setSound('Выход выбран. Проверьте звук.');
      }
    } catch (cause) {
      if (!valid()) return;

      if (kind === 'microphone') setMic(audioError(cause));
      else
        setSound(
          cause instanceof Error && cause.name === 'NotAllowedError'
            ? 'Нужно включить звук. Повторите проверку и проверьте разрешения браузера.'
            : audioError(cause),
        );
    } finally {
      if (valid()) setBusy(false);
    }
  }

  const outputSupported =
    !!navigator.mediaDevices &&
    canSelectOutput(navigator.mediaDevices) &&
    typeof AudioContext !== 'undefined' &&
    'setSinkId' in AudioContext.prototype &&
    typeof HTMLMediaElement !== 'undefined' &&
    'setSinkId' in HTMLMediaElement.prototype;
  const labels = {
    unknown: 'Состояние разрешения неизвестно. Проверьте микрофон кнопкой ниже.',
    prompt: 'При обращении к микрофону браузер может запросить разрешение.',
    granted: 'Доступ разрешён. Доступность устройства проверяется отдельно.',
    denied: 'Доступ заблокирован. Разрешите микрофон в настройках сайта, браузера или ОС.',
  };

  return (
    <>
      <div className="push-settings">
        <strong>Микрофон</strong>
        <p>{labels[permission]}</p>
        <button
          className="secondary"
          disabled={!allowed || busy}
          onClick={(): void => {
            void run('microphone');
          }}
        >
          {permission === 'prompt' ? 'Разрешить микрофон' : 'Проверить микрофон'}
        </button>
        {mic && <p role="status">{mic}</p>}
        {!navigator.mediaDevices?.getUserMedia && <p>Для микрофона нужен HTTPS или localhost.</p>}
      </div>
      <div className="push-settings">
        <strong>Динамики и звук</strong>
        <p role="status">{sound}</p>
        <button
          className="secondary"
          disabled={!allowed || busy}
          onClick={(): void => {
            void run('sound');
          }}
        >
          Проверить звук
        </button>
        {playing && (
          <button
            className="secondary"
            onClick={(): void => {
              client.audioPreparation?.stop();
              setPlaying(false);
            }}
          >
            Остановить тест
          </button>
        )}
        {tested && (
          <div>
            <button
              className="secondary"
              onClick={(): void => {
                setSound('Слышимость подтверждена вами.');
                setTested(false);
              }}
            >
              Слышу
            </button>
            <button
              className="secondary"
              onClick={(): void => {
                setSound(
                  'Проверьте громкость, отключение звука вкладки, системный аудиовыход и гарнитуру.',
                );
                setTested(false);
              }}
            >
              Не слышу
            </button>
          </div>
        )}
        {outputSupported ? (
          <button
            className="secondary"
            disabled={!allowed || busy}
            onClick={(): void => {
              void run('output');
            }}
          >
            Выбрать аудиовыход
          </button>
        ) : (
          <p>Используется системный аудиовыход. Изменить его можно в настройках устройства.</p>
        )}
        {(state.audioBlocked || !state.audible) && state.owner && (
          <button
            className="secondary"
            onClick={(): void => {
              void client.enableRingtone();
              void client.playAudio();
            }}
          >
            Включить звук
          </button>
        )}
        {!allowed && (
          <p>
            {ongoing
              ? 'Тесты доступны после завершения звонка.'
              : 'Проверка доступна в основной вкладке, когда она не занята другим действием.'}
          </p>
        )}
      </div>
    </>
  );
}
