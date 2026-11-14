import './dialogs.css';

import { MessageCircle, Phone } from 'lucide-react';
import type { JSX } from 'react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  Link,
  Outlet,
  useNavigate,
  useParams,
  useRevalidator,
  useRouteLoaderData,
} from 'react-router';

import type { DeviceCore } from '../../shared/device';
import { deviceErrorMessage } from '../../shared/device/messages';
import { useBootstrap } from '../../shared/dialogs/context';
import { DialogModelEvent } from '../../shared/dialogs/live-models';
import type { DialogSummary } from '../../shared/dialogs/model';
import { dialogError, type DialogRuntime } from '../../shared/dialogs/runtime';
import { Avatar, Button, Modal, Skeleton } from '../../shared/ui';
import { useCalls } from '../calls/CallsProvider';
import { UserCard } from '../users/UserCard';
import { DialogsHeader } from './DialogsHeader';
import { time } from './format';
import type { DialogsData } from './loaders';

function Dialogs({
  runtime,
  device,
}: {
  runtime: DialogRuntime;
  device?: DeviceCore;
}): JSX.Element {
  const { dialogId } = useParams();
  const navigate = useNavigate();
  const { ongoing, enabled, setPerson, setMobile } = useCalls();
  const [callRequest, setCallRequest] = useState<{
    runtime: DialogRuntime;
    dialog: DialogSummary;
  } | null>(null);
  const [callError, setCallError] = useState('');
  const [preparingCall, setPreparingCall] = useState(false);
  const calling = useRef(false);
  const mounted = useRef(false);
  const attempt = useRef(0);
  const callTarget =
    callRequest?.runtime === runtime && !runtime.signal.aborted ? callRequest.dialog : null;
  const state = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot);
  const scroll = useRef<HTMLDivElement>(null);
  const model = runtime.listModel();
  const subscribe = useCallback(
    (listener: () => void): (() => void) => model.on(DialogModelEvent.ListChanged, listener),
    [model],
  );
  const result = useSyncExternalStore(subscribe, model.getSnapshot);

  useLayoutEffect((): (() => void) => {
    mounted.current = true;
    attempt.current++;
    setCallRequest(null);
    setCallError('');

    return (): void => {
      mounted.current = false;
      attempt.current++;
    };
  }, [runtime, dialogId]);
  useEffect((): void => {
    if (ongoing) {
      setCallRequest(null);
    }
  }, [ongoing]);

  async function dial(): Promise<void> {
    if (
      !callTarget ||
      !device ||
      !enabled ||
      ongoing ||
      calling.current ||
      runtime.signal.aborted
    ) {
      return;
    }

    const target = callTarget;
    const currentAttempt = ++attempt.current;

    calling.current = true;
    setPreparingCall(true);
    setCallRequest(null);
    setCallError('');
    setPerson({ id: target.peer_id, display_name: target.peer_display_name });

    try {
      await device.calls.dial(target.peer_id);

      if (mounted.current && currentAttempt === attempt.current && !runtime.signal.aborted) {
        setMobile(true);
        void navigate('/calls');
      }
    } catch (cause) {
      if (mounted.current && currentAttempt === attempt.current && !runtime.signal.aborted) {
        setCallError(deviceErrorMessage(cause));
      }
    } finally {
      calling.current = false;

      if (mounted.current) {
        setPreparingCall(false);
      }
    }
  }

  useEffect((): (() => void) => {
    runtime.section(true, false);

    return (): void => runtime.section(false);
  }, [runtime, dialogId]);
  useLayoutEffect((): void => {
    if (scroll.current) {
      scroll.current.scrollTop = runtime.listScroll;
    }
  }, [dialogId, result.status === 'ready']);

  let dialogsContent;

  if (result.status === 'starting') {
    dialogsContent = (
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
    );
  } else if (result.status === 'error') {
    dialogsContent = <p role="alert">{dialogError(result.error)}</p>;
  } else if (!result.items.length) {
    dialogsContent = (
      <div className="dialog-empty">
        <MessageCircle size={34} />
        <h3>Пока нет диалогов</h3>
        <p>Начните переписку из контактов</p>
        <Link to="/dialogs/contacts">К контактам</Link>
      </div>
    );
  } else {
    dialogsContent = result.items.map((dialog): JSX.Element => {
      const message = dialog.last_message;
      let subtitle: string | undefined;

      if (message) {
        subtitle = message.content.kind === 'text' ? message.content.text : 'Стикер';

        if (message.sender_id === runtime.scope.accountId) {
          subtitle = 'Вы: ' + subtitle;
        }
      }

      return (
        <div className="dialog-contact-row" key={dialog.dialog_id}>
          <Link
            to={'/dialogs/' + dialog.dialog_id}
            aria-current={dialogId === dialog.dialog_id ? 'page' : undefined}
            className={'dialog-contact' + (dialogId === dialog.dialog_id ? ' current' : '')}
          >
            <UserCard
              userId={dialog.peer_id}
              displayName={dialog.peer_display_name}
              subtitle={subtitle}
            />
            <span className="dialog-contact-meta">
              <time>{time(dialog.last_message_at ?? dialog.created_at)}</time>
              {dialog.has_unread_messages && (
                <span className="dialog-unread" aria-label="Есть непрочитанные сообщения" />
              )}
            </span>
          </Link>
          <Button
            variant="ghost"
            size="icon"
            className="dialog-icon"
            aria-label={ongoing ? 'Вернуться к звонку' : `Позвонить: ${dialog.peer_display_name}`}
            disabled={preparingCall || runtime.signal.aborted}
            onClick={(): void => {
              if (ongoing) {
                setMobile(true);
                void navigate('/calls');
              } else {
                setCallError('');
                setCallRequest({ runtime, dialog });
              }
            }}
          >
            <Phone size="var(--ui-size-20)" aria-hidden="true" />
          </Button>
        </div>
      );
    });
  }

  return (
    <div className={'dialogs-layout' + (dialogId ? ' dialog-selected' : '')}>
      <section className="dialogs-sidebar" aria-label="Диалоги">
        <DialogsHeader />
        {callError && (
          <p className="dialog-error" role="alert">
            {callError}
          </p>
        )}
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
          {dialogsContent}
          {runtime.listHasMore && (
            <button
              className="dialog-more"
              onClick={(): void => {
                void (async () => {
                  try {
                    return await runtime.refreshList(runtime.listOffset);
                  } catch (cause) {}
                })();
              }}
            >
              Ещё диалоги
            </button>
          )}
        </div>
      </section>
      {callTarget && !ongoing && (
        <Modal title="Позвонить?" close={(): void => setCallRequest(null)}>
          <div className="confirm-person">
            <Avatar name={callTarget.peer_display_name} seed={callTarget.peer_id} />
            <strong>{callTarget.peer_display_name}</strong>
          </div>
          <p>Для звонка понадобится доступ к микрофону.</p>
          <div className="modal-actions">
            <Button variant="secondary" onClick={(): void => setCallRequest(null)}>
              Отмена
            </Button>
            <Button
              disabled={!device || !enabled || preparingCall}
              onClick={(): void => void dial()}
            >
              Позвонить
            </Button>
          </div>
        </Modal>
      )}
      <Outlet />
    </div>
  );
}

export function DialogsPage(): JSX.Element {
  const { dialogId } = useParams();
  const { runtime: bootstrapRuntime, error, retry } = useBootstrap();
  const index = useRouteLoaderData<DialogsData>('dialog-index');
  const conversation = useRouteLoaderData<DialogsData>('dialog-conversation');
  const descriptor = index ?? conversation;
  const revalidator = useRevalidator();
  const reloadedScope = useRef<DialogRuntime | null>(null);
  const stale = descriptor?.runtime.signal.aborted ?? false;
  let runtime = bootstrapRuntime;

  if (descriptor) {
    runtime = stale ? null : descriptor.runtime;
  }

  useEffect((): void => {
    if (stale && bootstrapRuntime && reloadedScope.current !== bootstrapRuntime) {
      reloadedScope.current = bootstrapRuntime;
      void revalidator.revalidate();
    }
  }, [stale, bootstrapRuntime, revalidator]);

  return runtime ? (
    <Dialogs runtime={runtime} device={descriptor?.device} />
  ) : (
    <div className={'dialogs-layout' + (dialogId ? ' dialog-selected' : '')}>
      <section className="dialogs-sidebar" aria-label="Диалоги">
        <DialogsHeader />
        <div className="dialog-empty">
          <p role={error ? 'alert' : 'status'}>{error ?? 'Подготавливаем переписку…'}</p>
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
        </div>
      </section>
      <Outlet />
    </div>
  );
}
