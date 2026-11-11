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

  let callNotice;

  if (!state.owner) {
    callNotice = (
      <div role="status" className="tab-banner">
        Звонками управляет другая вкладка GChat.
        <button
          onClick={(): void =>
            void (async () => {
              try {
                return await device.calls.takeControl();
              } catch (cause) {}
            })()
          }
          disabled={ongoing}
        >
          Открыть здесь
        </button>
      </div>
    );
  } else if (!presentation.callingAvailable) {
    callNotice = (
      <div role="status" className="tab-banner">
        Управление звонками недоступно. Обновите приложение для продолжения.
      </div>
    );
  } else if (state.connection !== 'online') {
    callNotice = (
      <div role="status" className="tab-banner">
        Подключаем звонки… Кнопки станут доступны после подключения.
      </div>
    );
  } else {
    callNotice = null;
  }

  return (
    <>
      {callNotices && callNotice}
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
