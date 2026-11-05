import type { JSX } from 'react';
import { useSyncExternalStore } from 'react';

import { applyUpdate, subscribeUpdate, updateSnapshot } from '../shared/pwa-update';

export function PwaUpdate(): JSX.Element | null {
  const state = useSyncExternalStore(subscribeUpdate, updateSnapshot);

  if (!state.available && !state.error && !state.pending) return null;

  return (
    <div className="tab-banner" role="status">
      {state.error ||
        (state.pending
          ? 'Обновим GChat после завершения звонков во всех вкладках.'
          : 'Доступна новая версия GChat.')}
      {state.available && (
        <button
          disabled={state.pending}
          onClick={(): void => {
            void applyUpdate();
          }}
        >
          Обновить
        </button>
      )}
    </div>
  );
}
