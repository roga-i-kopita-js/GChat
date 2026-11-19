import { Check, Headphones } from 'lucide-react';
import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';

import { type AudioOutputSetup, LifecycleEvent } from '../../shared/device/api';
import { useDevicePresentation } from '../../shared/device/react';
import { Modal } from '../../shared/ui';
import { useCalls } from '../calls/CallsProvider';
import { AudioTestStatus } from './AudioTestStatus';
import { descriptions, titles } from './labels';
import { Group, Row, SettingsAction, SettingsScreen } from './ui';
import { useSettingsDevice } from './useSettingsDevice';

export function SettingsAudioRoute(): JSX.Element {
  const device = useSettingsDevice();
  const { audioOutput: support } = useDevicePresentation();
  const { call, ongoing, state: callState } = useCalls();
  const { audio, run, setSoundAnswer } = device;
  const [open, setOpen] = useState(false);
  const lease = useRef<AudioOutputSetup | null>(null);
  const lifetime = useRef<AbortController | null>(null);
  const setupCall = useRef<string | null>(null);
  const callId = call && call.state !== 'ended' ? call.call_id : null;
  const preferred = audio.preference;
  const preferredName =
    preferred?.mode === 'device'
      ? `${preferred.name || 'Выбранное устройство'}${preferred.availability === 'unavailable' ? ' — недоступно' : ''}`
      : 'Как выберет iOS';

  async function releaseSetup(): Promise<void> {
    lifetime.current?.abort();
    lifetime.current = null;
    const current = lease.current;

    lease.current = null;

    try {
      await current?.close();
    } catch {
      /* Native cycle cleanup also releases the lease. */
    }
  }

  function close(): void {
    device.stopAudioTest();
    setSoundAnswer('');
    setOpen(false);
    void releaseSetup();
  }

  useEffect(() => {
    const off = device.api.lifecycle.on(
      LifecycleEvent.VisibilityChanged,
      ({ visibility }): void => {
        if (visibility !== 'foreground') {
          close();
        }
      },
    );

    return (): void => {
      off();
      void releaseSetup();
    };
  }, [device.api]);

  useEffect((): void => {
    if (
      lifetime.current &&
      (callId !== setupCall.current || !callState.owner || (!support.preference && callState.busy))
    ) {
      close();
    }
  }, [callId, callState.owner, callState.busy, support.preference]);

  useEffect((): void => {
    if (open && audio.outputs === null) {
      close();
    }
  }, [audio.outputs, open]);

  async function begin(): Promise<void> {
    const controller = new AbortController();

    lifetime.current?.abort();
    lifetime.current = controller;
    setupCall.current = callId;
    const value = await run((): Promise<AudioOutputSetup> =>
      device.api.audio.outputs.beginSetup({ signal: controller.signal }),
    );

    if (value && !controller.signal.aborted) {
      lease.current = value;
      setSoundAnswer('');
      setOpen(true);
    }
  }

  const choices = (save: boolean): JSX.Element[] | undefined =>
    audio.outputs?.map((output, index) => (
      <SettingsAction
        key={output.id}
        device={device}
        disabled={!output.id}
        pressed={audio.output?.id === output.id}
        onClick={(): void => {
          void run((): Promise<void> =>
            save
              ? device.api.audio.outputs.setPreferred(output.id)
              : device.api.audio.outputs.select(output.id),
          );
        }}
      >
        {output.name || `Аудиоустройство ${index + 1}`}
        {audio.output?.id === output.id && (
          <Check size="var(--ui-control-icon-size)" aria-hidden="true" />
        )}
      </SettingsAction>
    ));

  let outputHint =
    'Системный выбор аудиовыхода из GChat в этом браузере недоступен. Проверьте системную панель звука и подключение гарнитуры. ';

  if (support.setup) {
    outputHint = support.preference
      ? 'Для проверки разговорных устройств может потребоваться разрешение микрофона. Голос не записывается. Другое воспроизведение может приостановиться. '
      : '«Выбрать и проверить» временно открывает микрофон до закрытия панели. Появится индикатор микрофона; голос не записывается и не передаётся. Другое воспроизведение может приостановиться. ';
  } else if (support.pick) {
    outputHint = 'Аудиовыход также можно выбрать средствами ОС. ';
  }

  return (
    <SettingsScreen parent="/settings/general" title={titles.audio} device={device}>
      <p className="settings-intro">{descriptions.audio}</p>
      <Group>
        {support.preference && (
          <Row icon={Headphones} title="Для новых звонков" value={preferredName} />
        )}
        <Row
          icon={Headphones}
          title={support.preference ? 'Сейчас используется' : 'Аудиовыход'}
          value={audio.output?.name ?? 'Системный выход'}
        />
        {support.setup && (support.preference || !ongoing) && (
          <SettingsAction
            device={device}
            onClick={(): void => {
              void begin();
            }}
          >
            Выбрать и проверить
          </SettingsAction>
        )}
        {!support.preference && support.select && choices(false)}
        {support.pick && (
          <SettingsAction
            device={device}
            onClick={(): void => {
              void run(() => device.api.audio.outputs.pick());
            }}
          >
            Выбрать аудиовыход
          </SettingsAction>
        )}
      </Group>
      {support.preference &&
        (device.state?.microphone.permission === 'denied' ||
          device.state?.microphone.permission === 'restricted') && (
          <Group>
            <SettingsAction
              device={device}
              onClick={(): void => {
                void run(() => device.api.permissions.openSettings());
              }}
            >
              Открыть настройки
            </SettingsAction>
          </Group>
        )}
      <p className="settings-note">
        {outputHint}
        Громкость меняется кнопками устройства.
      </p>
      <Group>
        <SettingsAction
          device={device}
          disabled={ongoing}
          onClick={(): void => {
            setSoundAnswer('');
            device.testAudio('sound');
          }}
        >
          Проверить звук
        </SettingsAction>
      </Group>
      {!open && <AudioTestStatus device={device} section="audio" />}
      {open && (
        <Modal title="Выбрать и проверить звук" close={close}>
          <Group>
            {support.preference && (
              <Row icon={Headphones} title="Для новых звонков" value={preferredName} />
            )}
            <Row
              icon={Headphones}
              title="Сейчас используется"
              value={audio.output?.name ?? 'Системный выход'}
            />
            {support.preference && (
              <SettingsAction
                device={device}
                pressed={preferred?.mode === 'system'}
                onClick={(): void => {
                  void run(() => device.api.audio.outputs.setPreferred(null));
                }}
              >
                Как выберет iOS
              </SettingsAction>
            )}
            {choices(support.preference)}
          </Group>
          {!support.preference && (audio.outputs?.length ?? 0) < 2 && (
            <p className="settings-note">
              Браузер не предоставил дополнительные аудиовыходы. Доступны только устройства из этого
              списка и системная панель звука.
            </p>
          )}
          <Group>
            <SettingsAction
              device={device}
              disabled={ongoing}
              onClick={(): void => {
                device.testAudio('sound');
              }}
            >
              Проверить звук
            </SettingsAction>
          </Group>
          <AudioTestStatus device={device} section="audio" />
          {device.error && <p role="alert">{device.error}</p>}
        </Modal>
      )}
    </SettingsScreen>
  );
}
