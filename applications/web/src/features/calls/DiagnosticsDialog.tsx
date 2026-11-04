import type { JSX } from 'react';

import { Modal } from '../../shared/ui';
import { useCalls } from './CallsProvider';

export function DiagnosticsDialog({ close }: { close: () => void }): JSX.Element {
  const { client, state, call, ongoing } = useCalls();

  return (
    <Modal title="Диагностика соединения" close={close}>
      {!state.owner && (
        <div className="tab-banner">
          Звонками управляет другая вкладка GChat.
          <button onClick={(): void => client.activate()} disabled={ongoing}>
            Открыть здесь
          </button>
        </div>
      )}
      <dl className="diagnostics">
        <dt>Соединение</dt>
        <dd>{state.connection}</dd>
        <dt>Вкладка</dt>
        <dd>{state.owner ? 'Основная' : 'Дополнительная'}</dd>
        <dt>Звонок</dt>
        <dd>{call?.call_id ?? '—'}</dd>
        <dt>Состояние / версия</dt>
        <dd>{call ? `${call.state} / ${call.version}` : '—'}</dd>
        <dt>WebRTC</dt>
        <dd>{state.media}</dd>
        <dt>Маршрут</dt>
        <dd data-testid="relay">{state.stats.relay ? 'TURN (relay)' : 'Не выбран'}</dd>
        <dt>Аудио отправлено</dt>
        <dd data-testid="rtp-sent">{state.stats.sent} байт</dd>
        <dt>Аудио получено</dt>
        <dd data-testid="rtp-received">{state.stats.received} байт</dd>
        <dt>Окно восстановления</dt>
        <dd>{call?.recovery_deadline ?? '—'}</dd>
      </dl>
    </Modal>
  );
}
