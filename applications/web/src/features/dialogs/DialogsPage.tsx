import './dialogs.css';

import { MessageCircle } from 'lucide-react';
import type { JSX } from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { Link, Outlet, useParams, useRevalidator, useRouteLoaderData } from 'react-router';

import { useBootstrap } from '../../shared/dialogs/context';
import { DialogModelEvent } from '../../shared/dialogs/live-models';
import { dialogError, type DialogRuntime } from '../../shared/dialogs/runtime';
import { Skeleton } from '../../shared/ui';
import { UserCard } from '../users/UserCard';
import { time } from './format';
import type { DialogsData } from './loaders';

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
    runtime.section(true, false);

    return (): void => runtime.section(false);
  }, [runtime, dialogId]);
  useLayoutEffect((): void => {
    if (scroll.current) {
      scroll.current.scrollTop = runtime.listScroll;
    }
  }, [dialogId, result.status === 'ready']);

  return (
    <div className={'dialogs-layout' + (dialogId ? ' dialog-selected' : '')}>
      <section className="dialogs-sidebar" aria-label="Диалоги">
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
            <div role="status" aria-label="Загрузка диалогов">
              {[0, 1, 2, 3].map((key): JSX.Element => (
                <div key={key} className="dialog-contact-loading">
                  <Skeleton variant="circular" width="var(--ui-control-height)" />
                  <div className="skeleton-copy">
                    <Skeleton width="55%" />
                    <Skeleton width="40%" height="var(--ui-font-caption)" />
                  </div>
                </div>
              ))}
            </div>
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
                <UserCard
                  userId={dialog.peer_id}
                  displayName={dialog.peer_display_name}
                  subtitle="Последнее сообщение"
                />
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
      <Outlet />
    </div>
  );
}

export function DialogsPage(): JSX.Element {
  const { runtime: bootstrapRuntime, error, retry } = useBootstrap();
  const index = useRouteLoaderData<DialogsData>('dialog-index');
  const conversation = useRouteLoaderData<DialogsData>('dialog-conversation');
  const descriptor = index ?? conversation;
  const revalidator = useRevalidator();
  const reloadedScope = useRef<DialogRuntime | null>(null);
  const stale = descriptor?.runtime.signal.aborted ?? false;
  const runtime = descriptor ? (stale ? null : descriptor.runtime) : bootstrapRuntime;

  useEffect((): void => {
    if (stale && bootstrapRuntime && reloadedScope.current !== bootstrapRuntime) {
      reloadedScope.current = bootstrapRuntime;
      void revalidator.revalidate();
    }
  }, [stale, bootstrapRuntime, revalidator]);

  return runtime ? (
    <Dialogs runtime={runtime} />
  ) : (
    <section className="dialog-empty">
      <p role={error ? 'alert' : 'status'}>{error ?? 'Подготавливаем переписку…'}</p>
      <Outlet />
      {error && (
        <button
          className="secondary"
          onClick={(): void => {
            retry();
            void revalidator.revalidate();
          }}
        >
          Повторить
        </button>
      )}
    </section>
  );
}
