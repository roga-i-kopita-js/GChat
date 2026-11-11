import './CallAudioOutput.css';

import { Check, Headphones } from 'lucide-react';
import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';

import { AudioEvent } from '../../shared/device/api';
import { deviceErrorMessage } from '../../shared/device/messages';
import { useDevice, useDevicePresentation, useDeviceState } from '../../shared/device/react';
import { Button, Modal } from '../../shared/ui';
import { LazyPanel } from '../../shared/ui/LazyPanel';

function OutputChoices({ disabled }: { disabled: boolean }): JSX.Element {
  const device = useDevice();
  const { audioOutput: support } = useDevicePresentation();
  const audio = useDeviceState(device.audio, AudioEvent.StateChanged);
  const lifetime = useRef(new AbortController());
  const running = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  let outputHint = 'Аудиовыход также можно выбрать средствами ОС. ';

  if (!support.select && !support.pick) {
    outputHint =
      'Этот браузер не поддерживает смену аудиовыхода из GChat. Выходом управляет ОС: проверьте системную панель звука и подключение гарнитуры. ';
  } else if (!support.pick) {
    outputHint =
      'Системный выбор в этом браузере недоступен. Выберите устройство из списка или проверьте системную панель звука. ';
  }

  useEffect(() => {
    const controller = new AbortController();

    lifetime.current = controller;

    return () => controller.abort();
  }, []);

  async function choose(id?: string): Promise<void> {
    if (running.current) {
      return;
    }

    const { signal } = lifetime.current;

    running.current = true;
    setBusy(true);
    setError('');

    try {
      if (id) {
        await device.audio.outputs.select(id, { signal });
      } else {
        // Keep the platform picker in the user gesture, before any awaited read.
        await device.audio.outputs.pick({ signal });
      }
    } catch (cause) {
      if (!signal.aborted) {
        setError(deviceErrorMessage(cause));
      }
    } finally {
      if (!signal.aborted) {
        running.current = false;
        setBusy(false);
      }
    }
  }

  return (
    <div className="call-audio-outputs" aria-busy={busy}>
      <p>
        Сейчас:{' '}
        {audio.output ? audio.output.name || 'Выбранное аудиоустройство' : 'Системный выход'}
      </p>
      {support.select &&
        audio.outputs?.map((output, index) => (
          <Button
            key={output.id}
            variant="secondary"
            disabled={disabled || busy || !output.id}
            aria-pressed={audio.output?.id === output.id}
            onClick={() => void choose(output.id)}
          >
            <Headphones aria-hidden="true" />
            <span>{output.name || `Аудиоустройство ${index + 1}`}</span>
            {audio.output?.id === output.id && <Check aria-hidden="true" />}
          </Button>
        ))}
      {support.pick && (
        <Button variant="secondary" disabled={disabled || busy} onClick={() => void choose()}>
          Системный выбор
        </Button>
      )}
      <p className="settings-note">
        {outputHint}
        Громкость меняется кнопками устройства.
      </p>
      {busy && <p role="status">Выбираем аудиовыход…</p>}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}

export function CallAudioOutput({ disabled }: { disabled: boolean }): JSX.Element {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button className="round-action" disabled={disabled} onClick={() => setOpen(true)}>
        <span>
          <Headphones size={25} aria-hidden="true" />
        </span>
        Аудиовыход
      </button>
      {open && (
        <Modal title="Аудиовыход" close={() => setOpen(false)}>
          <LazyPanel
            pending={<p role="status">Загружаем аудиоустройства…</p>}
            failed={
              <p role="alert">Не удалось получить аудиоустройства. Выберите выход средствами ОС.</p>
            }
          >
            <OutputChoices disabled={disabled} />
          </LazyPanel>
        </Modal>
      )}
    </>
  );
}
