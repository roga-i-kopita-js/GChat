import type { JSX } from 'react';
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';

import { useCalls } from '../features/calls/CallsProvider';
import { UpdateEvent } from '../shared/device';
import { useDevice, useDeviceState } from '../shared/device/react';

function UpdateDialog({ close, confirm }: { close(): void; confirm(): void }): JSX.Element {
  const ref = useRef<HTMLDialogElement>(null);

  useLayoutEffect((): (() => void) => {
    const dialog = ref.current;

    dialog?.showModal();

    return (): void => dialog?.close();
  }, []);

  return createPortal(
    <dialog
      ref={ref}
      className="pwa-update-dialog"
      aria-labelledby="pwa-update-title"
      aria-describedby="pwa-update-description"
      onCancel={(event): void => {
        event.preventDefault();
        close();
      }}
      onKeyDown={(event): void => {
        if (event.key !== 'Tab') {
          return;
        }

        const buttons = event.currentTarget.querySelectorAll('button');
        const target = event.shiftKey ? buttons[0] : buttons[buttons.length - 1];

        if (document.activeElement === target) {
          event.preventDefault();
          (event.shiftKey ? buttons[buttons.length - 1] : buttons[0])?.focus();
        }
      }}
      onClick={(event): void => {
        if (event.target !== event.currentTarget) {
          return;
        }

        const bounds = event.currentTarget.getBoundingClientRect();

        if (
          event.clientX < bounds.left ||
          event.clientX > bounds.right ||
          event.clientY < bounds.top ||
          event.clientY > bounds.bottom
        ) {
          close();
        }
      }}
    >
      <div className="pwa-update-copy">
        <h2 id="pwa-update-title">Обновление GChat</h2>
        <p id="pwa-update-description">Доступна новая версия. Обновить приложение сейчас?</p>
      </div>
      <div className="pwa-update-actions">
        <button autoFocus onClick={close}>
          Позже
        </button>
        <button onClick={confirm}>Обновить</button>
      </div>
    </dialog>,
    document.body,
  );
}

export function PwaUpdate(): JSX.Element | null {
  const device = useDevice();
  const update = useDeviceState(device.updates, UpdateEvent.StateChanged);
  const state = {
    available: ['available', 'waiting', 'applying'].includes(update.status),
    pending: update.status === 'waiting' || update.status === 'applying',
    error: update.error?.message ?? '',
  };
  const { ongoing, state: calls } = useCalls();
  const [dismissed, setDismissed] = useState(false);
  const [requested, setRequested] = useState(false);
  const [availableSurface, setAvailableSurface] = useState(false);

  useEffect((): (() => void) => {
    const inspect = (): void => {
      const otherDialog = document.querySelector(
        'dialog[open]:not(.pwa-update-dialog), [role="dialog"][aria-modal="true"]:not(.pwa-update-dialog)',
      );

      setAvailableSurface(document.visibilityState === 'visible' && !otherDialog);
    };
    const observer = new MutationObserver(inspect);

    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['open', 'role', 'aria-modal', 'hidden'],
    });
    document.addEventListener('visibilitychange', inspect);
    inspect();

    return (): void => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', inspect);
    };
  }, []);

  useEffect((): void => {
    if (state.pending) {
      setRequested(false);
    }
  }, [state.pending]);

  if (!state.available && !state.error && !state.pending) {
    return null;
  }

  const showDialog =
    state.available &&
    !state.pending &&
    (requested || (!dismissed && !state.error)) &&
    availableSurface &&
    !ongoing &&
    !calls.busy;
  const close = (): void => {
    setDismissed(true);
    setRequested(false);
  };

  return (
    <>
      <div className="tab-banner" role="status">
        {state.pending
          ? 'Обновление запрошено. GChat перезапустится после завершения звонков во всех окнах.'
          : state.error || 'Доступна новая версия GChat.'}
        {state.available && !state.pending && (
          <button onClick={(): void => setRequested(true)}>
            {state.error ? 'Повторить' : 'Обновить'}
          </button>
        )}
      </div>
      {showDialog && (
        <UpdateDialog
          close={close}
          confirm={(): void => {
            close();
            void device.updates.apply().catch((): void => {});
          }}
        />
      )}
    </>
  );
}
