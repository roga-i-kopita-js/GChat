import type { CallHistoryItemDto } from '@gchat/backend-api';
import { ArrowLeft } from 'lucide-react';
import type { JSX } from 'react';
import { useSyncExternalStore } from 'react';
import { Link, useLoaderData, useOutletContext, useRouteLoaderData } from 'react-router';

import { Avatar, Button } from '../../shared/ui';
import { useCalls } from './CallsProvider';
import { historyDuration, historyLabel, historyTime } from './history-format';
import type { CallHistoryData, CallHistoryDetailData } from './history-loaders';

export function CallHistoryDetails(): JSX.Element {
  const { model, id } = useLoaderData<CallHistoryDetailData>();
  const parent = useRouteLoaderData<CallHistoryData>('calls-history');
  const snapshot = useSyncExternalStore(model.on, model.getSnapshot);
  const detail = snapshot.details[id];
  const item = snapshot.records[id];
  const { redial } = useOutletContext<{ redial(item: CallHistoryItemDto): void }>();
  const { enabled, ongoing } = useCalls();
  const back = '/calls' + (parent?.filter === 'missed' ? '?filter=missed' : '');
  let interruption = '';

  if (item?.end_reason === 'connection_lost') {
    interruption = 'Соединение потеряно';
  }

  if (item?.end_reason === 'session_revoked') {
    interruption = 'Сессия завершена';
  }

  if (item?.end_reason === 'account_disabled') {
    interruption = 'Аккаунт отключён';
  }

  return (
    <section className="history-details" aria-label="Сведения о звонке">
      <Link className="mobile-back" to={back}>
        <ArrowLeft size={18} /> Звонки
      </Link>
      {!snapshot.stopped && detail?.missing && (
        <div className="list-empty">
          <h3>Звонок не найден</h3>
          <p>Запись недоступна.</p>
        </div>
      )}
      {!snapshot.stopped && !detail?.missing && (
        <>
          {detail?.error && (
            <div className="history-error" role="alert">
              <p>{detail.error}</p>
              <Button
                variant="secondary"
                onClick={(): void => {
                  void model.detail(id);
                }}
              >
                Повторить
              </Button>
            </div>
          )}
          {!item && !detail?.error && <p role="status">Загружаем сведения…</p>}
          {item && (
            <>
              <div className="history-profile">
                <Avatar name={item.peer_display_name} seed={item.peer_id} large />
                <h2>{item.peer_display_name}</h2>
              </div>
              <dl className="history-facts">
                <div>
                  <dt>Дата</dt>
                  <dd>
                    {new Date(item.created_at).toLocaleDateString('ru', {
                      day: 'numeric',
                      month: 'long',
                      year: 'numeric',
                    })}
                  </dd>
                </div>
                <div>
                  <dt>Время</dt>
                  <dd>{historyTime(item.created_at)}</dd>
                </div>
                <div>
                  <dt>Направление</dt>
                  <dd>{item.direction === 'incoming' ? 'Входящий' : 'Исходящий'}</dd>
                </div>
                <div>
                  <dt>Результат</dt>
                  <dd>{historyLabel(item)}</dd>
                </div>
                {item.duration_seconds !== null && (
                  <div>
                    <dt>Разговор</dt>
                    <dd>{historyDuration(item.duration_seconds)}</dd>
                  </div>
                )}
                {item.outcome === 'completed' && interruption && (
                  <div>
                    <dt>Завершение</dt>
                    <dd>{interruption}</dd>
                  </div>
                )}
              </dl>
              <Button disabled={!enabled || ongoing} onClick={(): void => redial(item)}>
                Позвонить
              </Button>
            </>
          )}
        </>
      )}
    </section>
  );
}
