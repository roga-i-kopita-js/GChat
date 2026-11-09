import { useEffect, useRef, useState } from 'react';
import { useLoaderData, useRevalidator } from 'react-router';

import { AudioEvent, type AudioState, type DeviceCore, DeviceError } from '../../shared/device';
import type { DeviceState } from '../../shared/device/contract';
import { deviceErrorMessage } from '../../shared/device/messages';
import { useDeviceSettingsSnapshot, useDeviceState } from '../../shared/device/react';
import type { SettingsData } from './loaders';

export interface SettingsDevice {
  api: DeviceCore;
  state: DeviceState | null;
  audio: AudioState;
  error: string;
  busy: boolean;
  soundAnswer: string;
  setSoundAnswer(value: string): void;
  setError(value: string): void;
  setBusy(value: boolean): void;
  refresh(): Promise<void>;
  run<T>(operation: () => Promise<T>): Promise<T | undefined>;
  testAudio(kind: 'microphone' | 'sound'): void;
  stopAudioTest(): void;
}

export function useSettingsDevice(): SettingsDevice {
  const loaded = useLoaderData<SettingsData>();
  const api = loaded.device;
  const state = useDeviceSettingsSnapshot() ?? loaded.state;
  const revalidator = useRevalidator();
  const refresh = (): Promise<void> => revalidator.revalidate();
  const audio = useDeviceState(api.audio, AudioEvent.StateChanged);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [startingTest, setStartingTest] = useState(false);
  const [soundAnswer, setSoundAnswer] = useState('');
  const generation = useRef(0);
  const test = useRef<AbortController | null>(null);
  const output = useRef(audio.output?.id ?? null);

  // This is only an answer to a user-operated hearing test, not a second hardware state.
  if (output.current !== (audio.output?.id ?? null)) {
    output.current = audio.output?.id ?? null;

    if (soundAnswer) {
      setSoundAnswer('');
    }
  }

  useEffect(
    (): (() => void) => (): void => {
      generation.current++;
      test.current?.abort();
    },
    [api],
  );
  async function run<T>(operation: () => Promise<T>): Promise<T | undefined> {
    const epoch = generation.current;

    setBusy(true);
    setError('');

    try {
      const value = await operation();

      if (epoch === generation.current) {
        await refresh();
      }

      return value;
    } catch (cause) {
      if (
        epoch === generation.current &&
        !(cause instanceof DeviceError && cause.code === 'CANCELLED')
      ) {
        setError(deviceErrorMessage(cause));
      }
    } finally {
      if (epoch === generation.current) {
        setBusy(false);
      }
    }
  }
  const testAudio = (kind: 'microphone' | 'sound'): void => {
    if (test.current) {
      return;
    }

    const controller = new AbortController();

    test.current = controller;
    setStartingTest(true);
    setError('');
    setSoundAnswer('');
    const epoch = generation.current;

    void (async () => {
      try {
        const report = await api.audio.test({ kind }, { signal: controller.signal });

        if (epoch !== generation.current) {
          return;
        }

        const { checks: reportChecks } = report;
        const failed = reportChecks.find((item): boolean => item.status === 'failed');

        if (failed?.status === 'failed') {
          setError(failed.error.message);
        }
      } catch (cause) {
        if (epoch === generation.current && !controller.signal.aborted) {
          setError(deviceErrorMessage(cause));
        }
      } finally {
        if (test.current === controller) {
          test.current = null;
        }

        if (epoch === generation.current) {
          setStartingTest(false);
        }
      }
    })();
  };

  return {
    api,
    state,
    audio,
    error: error || loaded.error || '',
    busy: busy || (startingTest && state?.audio.test?.status !== 'running'),
    soundAnswer,
    setSoundAnswer,
    setError,
    setBusy,
    refresh,
    run,
    testAudio,
    stopAudioTest: (): void => test.current?.abort(),
  };
}
