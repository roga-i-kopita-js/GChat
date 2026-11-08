import type { JSX } from 'react';
import { lazy } from 'react';

import { useDevice, useDevicePresentation } from '../../shared/device/react';
import { LazyPanel } from '../../shared/ui/LazyPanel';
import { useCalls } from './CallsProvider';

const Card = lazy(async (): Promise<{ default: typeof import('./CallCard').CallCard }> => ({
  default: (await import('./CallCard')).CallCard,
}));

/** Keep essential incoming/active call controls usable even if the UI chunk fails. */
function CallCardFallback({ failed = false }: { failed?: boolean }): JSX.Element | null {
  const device = useDevice();
  const presentation = useDevicePresentation();
  const { call, incoming, enabled, state, status } = useCalls();

  if (!call) {
    return null;
  }

  return (
    <div className="call-card">
      <p role={failed ? 'alert' : 'status'}>
        {failed ? 'Не удалось загрузить экран звонка.' : 'Загружаем экран звонка…'}
      </p>
      <p>{status}</p>
      {state.error && <p role="alert">{state.error}</p>}
      {presentation.callControls === 'application' && call.state !== 'ended' && (
        <div className="call-controls">
          {incoming && (
            <button
              className="primary"
              disabled={!enabled}
              onClick={(): void => {
                void device.calls.accept().catch((): void => {});
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
                void device.calls.end().catch((): void => {});
              }}
            >
              {incoming ? 'Отклонить' : call.state === 'ringing' ? 'Отменить' : 'Завершить'}
            </button>
          )}
        </div>
      )}
      {presentation.callControls === 'host' && <p>Управление звонком доступно в приложении.</p>}
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
