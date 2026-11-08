import './dialogs.css';

import { MessageCircle } from 'lucide-react';
import type { JSX } from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { Link, Outlet, useParams } from 'react-router';

import { useBootstrap } from '../../shared/dialogs/context';
import { DialogModelEvent } from '../../shared/dialogs/live-models';
import { dialogError, type DialogRuntime } from '../../shared/dialogs/runtime';
import { Avatar } from '../../shared/ui';
import { time } from './format';

function Dialogs({ runtime }: { runtime: DialogRuntime }): JSX.Element {
  const { dialogId } = useParams();
  const state = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot);
  const scroll = useRef<HTMLDivElement>(null);
  const model = runtime.listModel();
  const subscribe = useCallback(
    (listener: () => void): (() => void) => model.on(DialogModelEvent.ListChanged, listener),
    [model],
  );
  const result = useSyncExternalStore(subscribe, model.getSnapshot);

  useEffect((): (() => void) => {
    runtime.section(true);

    return (): void => runtime.section(false);
  }, [runtime]);
  useLayoutEffect((): void => {
    if (scroll.current) {
      scroll.current.scrollTop = runtime.listScroll;
    }
  }, [dialogId, result.status === 'ready']);

  return (
    <div className={'dialogs-layout' + (dialogId ? ' dialog-selected' : '')}>
      <section className="dialogs-sidebar" aria-label="Диалоги">
        <header>
          <h1>Диалоги</h1>
        </header>
        {state.storageWarning && (
          <p className="dialog-notice" role="status">
            {state.storageWarning}
          </p>
        )}
        {state.error && (
          <div role="alert" className="dialog-error">
            {state.error}
            <button onClick={(): void => runtime.refresh()}>Повторить</button>
          </div>
        )}
        <div
          className="dialogs-list"
          ref={scroll}
          onScroll={(event): void => {
            runtime.listScroll = event.currentTarget.scrollTop;
          }}
        >
          {result.status === 'starting' ? (
            <p role="status">Загружаем диалоги…</p>
          ) : result.status === 'error' ? (
            <p role="alert">{dialogError(result.error)}</p>
          ) : !result.items.length ? (
            <div className="dialog-empty">
              <MessageCircle size={34} />
              <h3>Пока нет диалогов</h3>
              <p>Начните переписку из контактов</p>
              <Link to="/calls">К контактам</Link>
            </div>
          ) : (
            result.items.map((dialog): JSX.Element => (
              <Link
                key={dialog.dialog_id}
                to={'/dialogs/' + dialog.dialog_id}
                aria-current={dialogId === dialog.dialog_id ? 'page' : undefined}
                className={'dialog-contact' + (dialogId === dialog.dialog_id ? ' current' : '')}
              >
                <Avatar name={dialog.peer_display_name} seed={dialog.peer_id} />
                <span className="dialog-contact-name">{dialog.peer_display_name}</span>
                <span className="dialog-contact-meta">
                  <time>{time(dialog.last_message_at ?? dialog.created_at)}</time>
                  {dialog.has_unread_messages && (
                    <span className="dialog-unread" aria-label="Есть непрочитанные сообщения" />
                  )}
                </span>
              </Link>
            ))
          )}
          {runtime.listHasMore && (
            <button
              className="dialog-more"
              onClick={(): void => {
                void runtime.refreshList(runtime.listOffset).catch((): void => {});
              }}
            >
              Ещё диалоги
            </button>
          )}
        </div>
      </section>
      <Outlet context={runtime} />
    </div>
  );
}

export function DialogsPage(): JSX.Element {
  const { runtime, error, retry } = useBootstrap();

  return runtime ? (
    <Dialogs runtime={runtime} />
  ) : (
    <section className="dialog-empty">
      <p role={error ? 'alert' : 'status'}>{error ?? 'Подготавливаем переписку…'}</p>
      {error && (
        <button className="secondary" onClick={retry}>
          Повторить
        </button>
      )}
    </section>
  );
}
