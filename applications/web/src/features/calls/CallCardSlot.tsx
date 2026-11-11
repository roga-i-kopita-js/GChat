import type { JSX } from 'react';
import { lazy } from 'react';

import { useDevice } from '../../shared/device/react';
import { LazyPanel } from '../../shared/ui/LazyPanel';
import { useCalls } from './CallsProvider';

const Card = lazy(async (): Promise<{ default: typeof import('./CallCard').CallCard }> => {
  const { CallCard: resultCallCard } = await import('./CallCard');

  return {
    default: resultCallCard,
  };
});

/** Keep essential incoming/active call controls usable even if the UI chunk fails. */
function CallCardFallback({ failed = false }: { failed?: boolean }): JSX.Element | null {
  const device = useDevice();
  const { call, incoming, enabled, state, status } = useCalls();

  if (!call) {
    return null;
  }

  let endCallLabel;

  if (incoming) {
    endCallLabel = 'Отклонить';
  } else if (call.state === 'ringing') {
    endCallLabel = 'Отменить';
  } else {
    endCallLabel = 'Завершить';
  }

  return (
    <div className="call-card">
      <p role={failed ? 'alert' : 'status'}>
        {failed ? 'Не удалось загрузить экран звонка.' : 'Загружаем экран звонка…'}
      </p>
      <p>{status}</p>
      {state.error && <p role="alert">{state.error}</p>}
      {call.state !== 'ended' && (
        <div className="call-controls">
          {incoming && (
            <button
              className="primary"
              disabled={!enabled}
              onClick={(): void => {
                void (async () => {
                  try {
                    return await device.calls.accept();
                  } catch (cause) {}
                })();
              }}
            >
              Принять
            </button>
          )}
          {(incoming || state.selected) && (
            <button
              className="secondary"
              disabled={!enabled}
              onClick={(): void => {
                void (async () => {
                  try {
                    return await device.calls.end();
                  } catch (cause) {}
                })();
              }}
            >
              {endCallLabel}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function CallCardSlot(): JSX.Element {
  return (
    <LazyPanel pending={<CallCardFallback />} failed={<CallCardFallback failed />}>
      <Card />
    </LazyPanel>
  );
}
