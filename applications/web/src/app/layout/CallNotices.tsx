import { X } from 'lucide-react';
import type { JSX } from 'react';

import { useCalls } from '../../features/calls/CallsProvider';
import { useDevice, useDevicePresentation } from '../../shared/device/react';
import { useLayout } from './LayoutProvider';

export function CallNotices(): JSX.Element {
  const device = useDevice();
  const presentation = useDevicePresentation();
  const { state, ongoing } = useCalls();
  const { callNotices } = useLayout();

  return (
    <>
      {callNotices &&
        (!state.owner ? (
          <div role="status" className="tab-banner">
            Звонками управляет другая вкладка GChat.
            <button
              onClick={(): void => void device.calls.takeControl().catch((): void => {})}
              disabled={ongoing}
            >
              Открыть здесь
            </button>
          </div>
        ) : presentation.callControls === 'host' && !presentation.callingAvailable ? (
          <div role="status" className="tab-banner">
            Звонки в этой сборке приложения пока недоступны.
          </div>
        ) : state.connection !== 'online' ? (
          <div role="status" className="tab-banner">
            Подключаем звонки… Кнопки станут доступны после подключения.
          </div>
        ) : null)}
      {state.error && (
        <div role="alert" className="error-banner">
          {state.error}
          <button
            className="icon"
            aria-label="Закрыть сообщение"
            onClick={(): void => device.calls.clearError()}
          >
            <X size={17} />
          </button>
        </div>
      )}
    </>
  );
}
