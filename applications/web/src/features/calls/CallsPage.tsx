import './history.css';

import type { CallHistoryItemDto } from '@gchat/backend-api';
import {
  ArrowLeft,
  Phone,
  PhoneIncoming,
  PhoneMissed,
  PhoneOutgoing,
  RefreshCw,
} from 'lucide-react';
import type { JSX } from 'react';
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Link, Outlet, useLoaderData, useLocation, useNavigate, useParams } from 'react-router';

import { deviceErrorMessage } from '../../shared/device/messages';
import { Button, Modal, Skeleton } from '../../shared/ui';
import { useAuth } from '../auth/AuthProvider';
import { UserCard } from '../users/UserCard';
import { CallCardSlot } from './CallCardSlot';
import { useCalls } from './CallsProvider';
import { historyDay, historyDuration, historyLabel, historyTime } from './history-format';
import type { CallHistoryData } from './history-loaders';
import type { CallHistoryModel } from './history-model';

export function CallsPage(): JSX.Element {
  const { model, filter, sid } = useLoaderData<CallHistoryData>();
  const snapshot = useSyncExternalStore(model.on, model.getSnapshot);
  const { user } = useAuth();
  const { call, incoming, ongoing, enabled, mobile, setMobile, setPerson } = useCalls();
  const { callId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const view = snapshot.views[filter];
  const scroll = useRef<HTMLDivElement>(null);
  const [confirmation, setConfirmation] = useState<{
    item: CallHistoryItemDto;
    owner: CallHistoryModel;
  } | null>(null);
  const confirm = confirmation?.owner === model ? confirmation.item : null;
  const [error, setError] = useState('');
  const [preparing, setPreparing] = useState(false);
  const acting = useRef(false);
  const attempt = useRef(0);
  const showingCall = !!call && !incoming && mobile;
  const valid = sid === user?.sid && !snapshot.stopped;
  const back = '/calls' + (filter === 'missed' ? '?filter=missed' : '');

  useEffect((): (() => void) => model.visible(filter), [model, filter]);
  useEffect((): (() => void) => {
    attempt.current++;
    setConfirmation(null);
    setError('');

    return (): void => {
      attempt.current++;
    };
  }, [sid, model, location.pathname, filter]);
  useEffect((): void => {
    if (incoming || ongoing) {
      setConfirmation(null);
    }
  }, [incoming, ongoing]);
  useLayoutEffect((): void => {
    if (scroll.current && scroll.current.clientHeight > 0) {
      scroll.current.scrollTop = model.scroll[filter];
    }
  }, [model, filter, callId, showingCall, view.ids]);

  function redial(item: CallHistoryItemDto): void {
    setError('');
    setConfirmation({ item, owner: model });
  }

  async function dial(item: CallHistoryItemDto): Promise<void> {
    if (acting.current || !enabled || ongoing || !valid) {
      return;
    }

    acting.current = true;
    setPreparing(true);
    const id = ++attempt.current;

    setConfirmation(null);
    setError('');
    setPerson({ id: item.peer_id, display_name: item.peer_display_name });

    try {
      await model.device.calls.dial(item.peer_id);

      if (id === attempt.current && !model.getSnapshot().stopped) {
        setMobile(true);

        if (callId) {
          void navigate(back);
        }
      }
    } catch (cause) {
      if (id === attempt.current) {
        setError(deviceErrorMessage(cause));
      }
    } finally {
      acting.current = false;
      setPreparing(false);
    }
  }

  let day = '';
  const rows = valid
    ? view.ids.map((id): JSX.Element | null => {
        const item = snapshot.records[id];

        if (!item) {
          return null;
        }

        const label = historyDay(item.created_at);
        const heading = day !== label;

        day = label;
        let Icon = item.direction === 'incoming' ? PhoneIncoming : PhoneOutgoing;

        if (item.outcome === 'missed') {
          Icon = PhoneMissed;
        }

        return (
          <div key={id}>
            {heading && <h3 className="history-day">{label}</h3>}
            <div
              className={
                'history-row' +
                (item.outcome === 'missed' ? ' history-missed' : '') +
                (callId === id ? ' history-selected' : '')
              }
            >
              <Link
                className="history-person"
                to={'/calls/' + id + (filter === 'missed' ? '?filter=missed' : '')}
                aria-label={`Сведения о звонке: ${item.peer_display_name}, ${historyLabel(item)}, ${historyTime(item.created_at)}`}
              >
                <UserCard userId={item.peer_id} displayName={item.peer_display_name} />
                <span className="history-subtitle">
                  <Icon size={13} aria-hidden="true" />
                  {historyLabel(item)}
                  {item.duration_seconds !== null && ' · ' + historyDuration(item.duration_seconds)}
                </span>
                <time className="history-time" dateTime={item.created_at}>
                  {historyTime(item.created_at)}
                </time>
              </Link>
              <Button
                variant="ghost"
                size="icon"
                className="history-redial"
                aria-label={'Позвонить: ' + item.peer_display_name}
                disabled={!enabled || ongoing || preparing}
                onClick={(): void => redial(item)}
              >
                <Phone size={18} aria-hidden="true" />
              </Button>
            </div>
          </div>
        );
      })
    : [];

  let detailPanel: JSX.Element;

  if (showingCall) {
    detailPanel = (
      <>
        <Button className="history-collapse" variant="ghost" onClick={(): void => setMobile(false)}>
          <ArrowLeft size={18} /> История звонков
        </Button>
        <CallCardSlot />
      </>
    );
  } else if (callId) {
    detailPanel = <Outlet context={{ redial }} />;
  } else {
    detailPanel = (
      <div className="history-placeholder">
        <Phone size={30} />
        <p>Выберите звонок, чтобы посмотреть сведения</p>
      </div>
    );
  }

  return (
    <div className={'history-layout' + (callId || showingCall ? ' history-detail-open' : '')}>
      {error && (
        <p className="history-command-error" role="alert">
          {error}
        </p>
      )}
      <section className="history-panel" aria-label="История звонков">
        <div className="history-filter" role="group" aria-label="Фильтр истории звонков">
          <Link
            to="/calls"
            aria-current={filter === 'all' ? 'page' : undefined}
            className={'history-filter-button' + (filter === 'all' ? ' selected' : '')}
          >
            Все
          </Link>
          <Link
            to="/calls?filter=missed"
            aria-current={filter === 'missed' ? 'page' : undefined}
            className={'history-filter-button' + (filter === 'missed' ? ' selected' : '')}
          >
            Пропущенные
          </Link>
        </div>
        {ongoing && (
          <Button
            className="history-return"
            variant="secondary"
            onClick={(): void => setMobile(true)}
          >
            <Phone size={18} /> Вернуться к звонку
          </Button>
        )}
        <div
          className="history-list"
          ref={scroll}
          onScroll={(event): void => {
            if (event.currentTarget.clientHeight > 0) {
              model.scroll[filter] = event.currentTarget.scrollTop;
            }
          }}
        >
          {(!valid || (!view.loaded && view.loading)) && (
            <div role="status" aria-label="Загрузка истории звонков">
              {[0, 1, 2, 3].map((id): JSX.Element => (
                <div className="skeleton-row" key={id}>
                  <Skeleton variant="circular" width="var(--ui-control-height)" />
                  <div className="skeleton-copy">
                    <Skeleton width="60%" />
                    <Skeleton width="40%" />
                  </div>
                </div>
              ))}
            </div>
          )}
          {valid && view.error && (
            <div className="history-error" role="alert">
              <p>{view.error}</p>
              <Button
                variant="secondary"
                onClick={(): void => {
                  void model.head(filter);
                }}
              >
                <RefreshCw size={16} /> Повторить
              </Button>
            </div>
          )}
          {valid && view.loaded && !view.ids.length && (
            <div className="list-empty">
              <Phone size={30} />
              <h3>{filter === 'missed' ? 'Пропущенных звонков нет' : 'Звонков пока нет'}</h3>
            </div>
          )}
          {rows}
          {valid && view.nextCursor && (
            <div className="history-more">
              <Button
                variant="secondary"
                disabled={view.loading || view.loadingMore}
                onClick={(): void => {
                  void model.more(filter);
                }}
              >
                {view.loadingMore ? 'Загружаем…' : 'Ещё звонки'}
              </Button>
            </div>
          )}
        </div>
      </section>
      <div className="history-detail-panel">{detailPanel}</div>
      {confirm && valid && !ongoing && (
        <Modal title="Позвонить?" close={(): void => setConfirmation(null)}>
          <div className="confirm-person">
            <UserCard userId={confirm.peer_id} displayName={confirm.peer_display_name} />
          </div>
          <div className="modal-actions">
            <Button variant="secondary" onClick={(): void => setConfirmation(null)}>
              Отмена
            </Button>
            <Button
              disabled={!enabled || preparing}
              onClick={(): void => {
                void dial(confirm);
              }}
            >
              Позвонить
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}
