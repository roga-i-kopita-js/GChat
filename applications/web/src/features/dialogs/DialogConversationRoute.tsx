import './dialogs.css';

import {
  ArrowDown,
  ArrowLeft,
  Check,
  CheckCheck,
  Ellipsis,
  MessageCircle,
  Phone,
} from 'lucide-react';
import type { JSX } from 'react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { Link, useLoaderData, useNavigate } from 'react-router';
import { VList, type VListHandle } from 'virtua';

import type { DeviceCore } from '../../shared/device';
import { deviceErrorMessage } from '../../shared/device/messages';
import { DialogModelEvent } from '../../shared/dialogs/live-models';
import { type DialogMessage, isStickerId, type PendingMessage } from '../../shared/dialogs/model';
import { dialogError, type DialogRuntime, type DialogView } from '../../shared/dialogs/runtime';
import { Avatar, Button, Modal, PageHeader, Skeleton, Text } from '../../shared/ui';
import { useCalls } from '../calls/CallsProvider';
import { Composer } from './Composer';
import { EditComposer } from './EditComposer';
import { time } from './format';
import type { DialogsData } from './loaders';
import { MessageMenu } from './MessageMenu';
import { stickers } from './stickers';

interface SendScrollRequest {
  clientId: string;
  sequence: number;
}

function Content({ content }: { content: DialogMessage['content'] }): JSX.Element {
  if (content.kind === 'text') {
    return <span className="dialog-message-text">{content.text}</span>;
  }

  return isStickerId(content.sticker_id) ? (
    <img
      src={stickers[content.sticker_id].url}
      width="132"
      height="132"
      alt={'Стикер: ' + stickers[content.sticker_id].label}
    />
  ) : (
    <span>Стикер</span>
  );
}
function Room({
  runtime,
  id,
  device,
}: {
  runtime: DialogRuntime;
  id: string;
  device: DeviceCore;
}): JSX.Element {
  const navigate = useNavigate();
  const { ongoing, enabled, setPerson, setMobile } = useCalls();
  const model = useMemo(
    (): ReturnType<DialogRuntime['conversationModel']> => runtime.conversationModel(id),
    [runtime, id],
  );
  const subscribe = useCallback(
    (listener: () => void): (() => void) =>
      model.on(DialogModelEvent.ConversationChanged, listener),
    [model],
  );
  const result = useSyncExternalStore(subscribe, model.getSnapshot);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<DialogMessage | null>(null);
  const [confirmCall, setConfirmCall] = useState(false);
  const [preparingCall, setPreparingCall] = useState(false);
  const calling = useRef(false);
  const mounted = useRef(false);
  const [sendScrollRequest, setSendScrollRequest] = useState<SendScrollRequest | null>(null);
  const sentLocally = useCallback(
    (clientId: string): void => {
      if (mounted.current && !runtime.signal.aborted) {
        setSendScrollRequest((previous) => ({ clientId, sequence: (previous?.sequence ?? 0) + 1 }));
      }
    },
    [runtime],
  );

  useEffect((): (() => void) => {
    mounted.current = true;

    return (): void => {
      mounted.current = false;
    };
  }, []);
  useEffect((): void => {
    if (ongoing) {
      setConfirmCall(false);
    }
  }, [ongoing]);

  useEffect((): (() => void) => {
    runtime.select(id, false);

    return (): void => runtime.select(null);
  }, [runtime, id]);
  const data = result.view;
  const loadingPeer = !data?.record.dialog && result.status !== 'error' && !data?.error;

  async function dial(): Promise<void> {
    const dialog = data?.record.dialog;

    if (!dialog || !enabled || ongoing || calling.current || runtime.signal.aborted) {
      return;
    }

    calling.current = true;
    setPreparingCall(true);
    setConfirmCall(false);
    setError('');
    setPerson({ id: dialog.peer_id, display_name: dialog.peer_display_name });

    try {
      await device.calls.dial(dialog.peer_id);

      if (mounted.current && !runtime.signal.aborted) {
        setMobile(true);
        void navigate('/calls');
      }
    } catch (cause) {
      if (mounted.current && !runtime.signal.aborted) {
        setError(deviceErrorMessage(cause));
      }
    } finally {
      calling.current = false;

      if (mounted.current && !runtime.signal.aborted) {
        setPreparingCall(false);
      }
    }
  }

  let conversationContent;

  if (result.status === 'error') {
    conversationContent = (
      <div className="dialog-empty">
        <p role="alert">{dialogError(result.error)}</p>
        <button
          onClick={(): void => {
            model.invalidate();
          }}
        >
          Повторить
        </button>
      </div>
    );
  } else if (!data) {
    conversationContent = (
      <div className="dialog-empty" role="status">
        Загружаем переписку…
      </div>
    );
  } else {
    let emptyHistoryMessage;

    if (data.record.permissions?.can_read === false) {
      emptyHistoryMessage = 'История недоступна';
    } else if (data.syncing || !data.record.permissions) {
      emptyHistoryMessage = 'Загружаем переписку…';
    } else {
      emptyHistoryMessage = 'Начните переписку';
    }

    conversationContent = (
      <>
        {data.record.permissions?.can_read === false && (
          <p className="dialog-notice">
            Серверная история недоступна. Здесь сохранены ранее загруженные сообщения.
          </p>
        )}
        {data.messages.length || data.record.outbox.length ? (
          <Feed
            runtime={runtime}
            id={id}
            data={data}
            report={setError}
            sendScrollRequest={sendScrollRequest}
            onPrepared={sentLocally}
            edit={(message): void => {
              if (!editing) {
                setEditing(message);
              }
            }}
          />
        ) : (
          <div className="dialog-empty" role="status">
            <MessageCircle size={36} />
            <h3>{emptyHistoryMessage}</h3>
            {data.record.permissions?.can_send && <p>Напишите первое сообщение</p>}
          </div>
        )}
        {data.record.permissions?.can_send || editing ? (
          <>
            <div hidden={!!editing}>
              <Composer
                key={id}
                runtime={runtime}
                id={id}
                draft={data.record.draft}
                onPrepared={sentLocally}
                editLast={(): boolean => {
                  const last = data.messages.findLast(
                    (message): boolean =>
                      message.sender_id === runtime.scope.accountId &&
                      message.content.kind === 'text',
                  );

                  if (!last || editing) {
                    return false;
                  }

                  setEditing(last);

                  return true;
                }}
              />
            </div>
            {editing && (
              <EditComposer
                key={editing.message_id}
                runtime={runtime}
                id={id}
                message={editing}
                canSend={!!data.record.permissions?.can_send}
                close={(): void => setEditing(null)}
              />
            )}
          </>
        ) : (
          <div className="dialog-disabled">
            {data.record.permissions
              ? 'Отправка сообщений недоступна'
              : 'Проверяем доступ к переписке…'}
          </div>
        )}
      </>
    );
  }

  let peerAvatar;

  if (data?.record.dialog) {
    peerAvatar = (
      <Avatar name={data.record.dialog.peer_display_name} seed={data.record.dialog.peer_id} />
    );
  } else if (loadingPeer) {
    peerAvatar = <Skeleton variant="circular" width="var(--ui-control-height)" />;
  } else {
    peerAvatar = null;
  }

  return (
    <section className="dialog-room" aria-label="Переписка">
      <PageHeader className="dialog-room-header" aria-busy={loadingPeer}>
        <Link to="/dialogs" className="dialog-icon dialog-back" aria-label="Назад к диалогам">
          <ArrowLeft size={22} />
        </Link>
        {peerAvatar}
        <Skeleton loading={loadingPeer} className="dialog-room-title">
          <Text as="h2" variant="heading">
            {data?.record.dialog?.peer_display_name ?? 'Переписка'}
          </Text>
        </Skeleton>
        <Button
          variant="ghost"
          size="icon"
          className="dialog-icon"
          aria-label={
            ongoing
              ? 'Вернуться к звонку'
              : `Позвонить: ${data?.record.dialog?.peer_display_name ?? 'собеседник'}`
          }
          disabled={!data?.record.dialog || preparingCall}
          onClick={(): void => {
            if (ongoing) {
              setMobile(true);
              void navigate('/calls');
            } else {
              setError('');
              setConfirmCall(true);
            }
          }}
        >
          <Phone size={19} />
        </Button>
      </PageHeader>
      {confirmCall && !ongoing && data?.record.dialog && (
        <Modal title="Позвонить?" close={(): void => setConfirmCall(false)}>
          <div className="confirm-person">
            <Avatar name={data.record.dialog.peer_display_name} seed={data.record.dialog.peer_id} />
            <strong>{data.record.dialog.peer_display_name}</strong>
          </div>
          <p>Для звонка понадобится доступ к микрофону.</p>
          <div className="modal-actions">
            <Button variant="secondary" onClick={(): void => setConfirmCall(false)}>
              Отмена
            </Button>
            <Button disabled={!enabled || preparingCall} onClick={(): void => void dial()}>
              Позвонить
            </Button>
          </div>
        </Modal>
      )}
      {data?.error && (
        <div className="dialog-error" role="alert">
          {data.error}
          <button
            onClick={(): void => {
              void runtime.sync(id, true);
            }}
          >
            Повторить
          </button>
        </div>
      )}
      {error && (
        <p className="dialog-error" role="alert">
          {error}
        </p>
      )}
      {conversationContent}
    </section>
  );
}
function Feed({
  runtime,
  id,
  data,
  report,
  edit,
  sendScrollRequest,
  onPrepared,
}: {
  runtime: DialogRuntime;
  id: string;
  data: DialogView;
  report(value: string): void;
  edit(message: DialogMessage): void;
  sendScrollRequest: SendScrollRequest | null;
  onPrepared(clientId: string): void;
}): JSX.Element {
  const [actionMessage, setActionMessage] = useState<{
    message: DialogMessage;
    anchor: HTMLElement;
  } | null>(null);
  const closeActions = useCallback(
    (restoreFocus: boolean): void => {
      if (restoreFocus && actionMessage?.anchor.isConnected) {
        actionMessage.anchor.focus({ preventScroll: true });
      }

      setActionMessage(null);
    },
    [actionMessage],
  );
  const pressPoint = useRef<{ x: number; y: number } | null>(null);
  const press = useRef<ReturnType<typeof setTimeout> | null>(null);

  function cancelPress(): void {
    if (press.current) {
      clearTimeout(press.current);
    }

    press.current = null;
    pressPoint.current = null;
  }
  useEffect((): (() => void) => cancelPress, []);
  const list = useRef<VListHandle>(null);
  const sticky = useRef(true);
  const followingOwnSend = useRef(false);
  const smoothScrolling = useRef(false);
  const resizeScroll = useRef<number | null>(null);
  const appliedSendScroll = useRef(0);
  const initialized = useRef(false);
  const previousFirst = useRef(data.messages[0]?.message_id);
  const previousCount = useRef(data.messages.length);
  const loading = useRef(false);
  const [older, setOlder] = useState(false);
  const [newMessages, setNewMessages] = useState(false);
  const shifted =
    previousFirst.current !== data.messages[0]?.message_id &&
    data.messages.length > previousCount.current &&
    previousFirst.current !== undefined;
  const items: (DialogMessage | PendingMessage)[] = [...data.messages, ...data.record.outbox];

  function scrollToEnd(smooth: boolean): void {
    const handle = list.current;

    if (!handle || !items.length) {
      return;
    }

    const animate = smooth && !matchMedia('(prefers-reduced-motion: reduce)').matches;

    smoothScrolling.current =
      animate && handle.scrollSize - handle.viewportSize - handle.scrollOffset > 1;
    handle.scrollToIndex(items.length - 1, { align: 'end', smooth: animate });
  }

  function stopFollowing(): void {
    if (sendScrollRequest) {
      appliedSendScroll.current = Math.max(appliedSendScroll.current, sendScrollRequest.sequence);
    }

    followingOwnSend.current = false;
    smoothScrolling.current = false;
    sticky.current = false;
  }

  function acknowledge(): void {
    const last = data.messages.at(-1)?.sequence ?? 0;

    runtime.shown(id, last, sticky.current);
  }
  useLayoutEffect((): void => {
    const handle = list.current;

    if (!handle) {
      return;
    }

    const ownSend =
      sendScrollRequest &&
      sendScrollRequest.sequence > appliedSendScroll.current &&
      items.some(
        (item): boolean =>
          item.client_message_id === sendScrollRequest.clientId &&
          (!('sender_id' in item) || item.sender_id === runtime.scope.accountId),
      );

    if (ownSend && sendScrollRequest) {
      initialized.current = true;
      appliedSendScroll.current = sendScrollRequest.sequence;
      followingOwnSend.current = true;
      setNewMessages(false);
      scrollToEnd(true);
    } else if (!initialized.current) {
      initialized.current = true;
      const position = runtime.positions.get(id);

      if (position) {
        const restored = position.messageId
          ? items.findIndex(
              (item): boolean =>
                ('message_id' in item ? item.message_id : item.client_message_id) ===
                position.messageId,
            )
          : position.index;

        handle.scrollToIndex(Math.max(0, restored), { align: 'start', offset: position.offset });
        sticky.current = false;
      } else {
        handle.scrollToIndex(items.length - 1, { align: 'end' });
      }
    } else if (followingOwnSend.current && !shifted) {
      if (!smoothScrolling.current) {
        scrollToEnd(true);
      }
    } else if (sticky.current && !shifted) {
      scrollToEnd(false);
    } else if (data.messages.length > previousCount.current && !shifted) {
      setNewMessages(true);
    }

    previousFirst.current = data.messages[0]?.message_id;
    previousCount.current = data.messages.length;
    acknowledge();
  }, [
    data.messages.length,
    data.messages.at(-1)?.message_id,
    data.record.outbox.length,
    sendScrollRequest?.sequence,
  ]);
  useEffect(
    (): (() => void) => (): void => {
      if (resizeScroll.current !== null) {
        cancelAnimationFrame(resizeScroll.current);
      }

      const handle = list.current;

      if (handle) {
        const index = handle.findItemIndex(handle.scrollOffset);

        runtime.positions.set(id, {
          index,
          messageId:
            items[index] &&
            ('message_id' in items[index]
              ? items[index].message_id
              : items[index].client_message_id),
          offset: handle.scrollOffset - handle.getItemOffset(index),
        });
      }
    },
    [runtime, id],
  );
  async function loadOlder(): Promise<void> {
    if (loading.current || !data.record.has_older || !data.record.permissions?.can_read) {
      return;
    }

    loading.current = true;
    setOlder(true);

    try {
      await runtime.older(id);
      report('');
    } catch (cause) {
      report(dialogError(cause));
    } finally {
      loading.current = false;
      setOlder(false);
    }
  }

  return (
    <div className="dialog-feed-wrapper">
      {actionMessage && (
        <MessageMenu
          anchor={actionMessage.anchor}
          close={closeActions}
          edit={(): void => {
            edit(actionMessage.message);
            setActionMessage(null);
          }}
        />
      )}
      {data.record.has_older && data.record.permissions?.can_read && (
        <button
          className="dialog-load-older"
          disabled={older}
          onClick={(): void => {
            void loadOlder();
          }}
        >
          {older ? 'Загружаем…' : 'Предыдущие сообщения'}
        </button>
      )}
      {data.record.ranges.length > 1 && (
        <button
          className="dialog-gap"
          onClick={(): void => {
            void runtime.sync(id);
          }}
        >
          Загрузить пропущенные сообщения
        </button>
      )}
      <VList
        ref={list}
        className="dialog-feed"
        aria-label="Сообщения"
        role="log"
        shift={shifted}
        onWheelCapture={stopFollowing}
        onPointerDownCapture={stopFollowing}
        onTouchMoveCapture={stopFollowing}
        onKeyDownCapture={(event): void => {
          if (
            ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)
          ) {
            stopFollowing();
          }
        }}
        onScrollEnd={(): void => {
          if (followingOwnSend.current) {
            smoothScrolling.current = false;
            const handle = list.current;

            if (handle && handle.scrollSize - handle.viewportSize - handle.scrollOffset > 1) {
              scrollToEnd(true);
            } else {
              followingOwnSend.current = false;
            }
          }
        }}
        onScroll={(offset): void => {
          const handle = list.current;

          if (!handle) {
            return;
          }

          sticky.current = handle.scrollSize - handle.viewportSize - offset <= 24;
          const index = handle.findItemIndex(offset);

          runtime.positions.set(id, {
            index,
            offset: offset - handle.getItemOffset(index),
            messageId:
              items[index] &&
              ('message_id' in items[index]
                ? items[index].message_id
                : items[index].client_message_id),
          });

          if (sticky.current) {
            setNewMessages(false);
          }

          acknowledge();

          if (offset < 100 && !followingOwnSend.current) {
            void loadOlder();
          }
        }}
        onResize={(): void => {
          if (resizeScroll.current !== null) {
            cancelAnimationFrame(resizeScroll.current);
          }

          // Wait for the measurement batch before adjusting the destination again.
          resizeScroll.current = requestAnimationFrame((): void => {
            resizeScroll.current = null;

            if (followingOwnSend.current || (!smoothScrolling.current && sticky.current)) {
              scrollToEnd(followingOwnSend.current);
            }
          });
        }}
      >
        {items.map((item): JSX.Element => {
          const saved = 'message_id' in item;
          const own = !saved || item.sender_id === runtime.scope.accountId;
          const read =
            saved && (item.status === 'read' || (own && item.sequence <= data.record.peer_read));

          let deliveryStatus;

          if (!saved && item.state === 'sending') {
            deliveryStatus = 'Результат ожидается';
          } else if (!saved && item.state === 'rejected') {
            deliveryStatus = 'Отклонено';
          } else {
            deliveryStatus = 'Результат неизвестен';
          }

          return (
            <div
              key={saved ? item.message_id : item.client_message_id}
              className={'dialog-message-row' + (own ? ' own' : '')}
            >
              <div className="dialog-message-container">
                <article
                  className={'dialog-message' + (item.content.kind === 'sticker' ? ' sticker' : '')}
                  tabIndex={
                    saved &&
                    own &&
                    item.content.kind === 'text' &&
                    data.record.permissions?.can_send
                      ? 0
                      : undefined
                  }
                  aria-haspopup={
                    saved &&
                    own &&
                    item.content.kind === 'text' &&
                    data.record.permissions?.can_send
                      ? 'menu'
                      : undefined
                  }
                  onKeyDown={(event): void => {
                    if (
                      saved &&
                      own &&
                      item.content.kind === 'text' &&
                      data.record.permissions?.can_send &&
                      (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))
                    ) {
                      event.preventDefault();
                      setActionMessage({ message: item, anchor: event.currentTarget });
                    }
                  }}

                  onContextMenu={(event): void => {
                    if (
                      saved &&
                      own &&
                      item.content.kind === 'text' &&
                      data.record.permissions?.can_send
                    ) {
                      event.preventDefault();
                      setActionMessage({ message: item, anchor: event.currentTarget });
                    }
                  }}
                  onPointerDown={(event): void => {
                    if (
                      event.pointerType !== 'touch' ||
                      !saved ||
                      !own ||
                      item.content.kind !== 'text' ||
                      !data.record.permissions?.can_send
                    ) {
                      return;
                    }

                    cancelPress();
                    const anchor = event.currentTarget;

                    pressPoint.current = { x: event.clientX, y: event.clientY };
                    press.current = setTimeout((): void => {
                      if (!window.getSelection()?.toString() && anchor.isConnected) {
                        setActionMessage({ message: item, anchor });
                      }
                    }, 500);
                  }}
                  onPointerUp={cancelPress}
                  onPointerMove={(event): void => {
                    const start = pressPoint.current;

                    if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8) {
                      cancelPress();
                    }
                  }}
                  onPointerCancel={cancelPress}
                >
                  <Content content={item.content} />
                  <div className="dialog-message-meta">
                    {saved && item.edited_at && (
                      <span aria-label="Сообщение изменено">изменено</span>
                    )}
                    <time dateTime={item.created_at}>{time(item.created_at)}</time>
                    {own &&
                      (saved ? (
                        <span aria-label={read ? 'Прочитано' : 'Отправлено'}>
                          {read ? <CheckCheck size={15} /> : <Check size={15} />}
                        </span>
                      ) : (
                        <span>{deliveryStatus}</span>
                      ))}
                  </div>
                  {!saved && (
                    <div className="dialog-retry">
                      {item.error && <span>{item.error}</span>}
                      <button
                        onClick={(): void => {
                          void (async () => {
                            try {
                              return await runtime.resend(id, item.client_message_id, onPrepared);
                            } catch (cause) {
                              return report(dialogError(cause));
                            }
                          })();
                        }}
                      >
                        Повторить
                      </button>
                    </div>
                  )}
                </article>
                {saved &&
                  own &&
                  item.content.kind === 'text' &&
                  data.record.permissions?.can_send && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="dialog-message-actions"
                      aria-label="Действия сообщения"
                      onClick={(event): void => {
                        const anchor = event.currentTarget.parentElement?.querySelector('article');

                        if (anchor) {
                          setActionMessage({ message: item, anchor });
                        }
                      }}
                    >
                      <Ellipsis size={16} />
                    </Button>
                  )}
              </div>
            </div>
          );
        })}
      </VList>
      {newMessages && (
        <button
          className="dialog-jump"
          onClick={(): void => {
            sticky.current = true;
            list.current?.scrollToIndex(items.length - 1, { align: 'end' });
            setNewMessages(false);
            acknowledge();
          }}
        >
          Новые сообщения <ArrowDown size={16} />
        </button>
      )}
    </div>
  );
}

export function DialogConversationRoute(): JSX.Element {
  const { device, runtime, dialogId } = useLoaderData<DialogsData>();

  if (!dialogId) {
    throw new Error('Conversation loader requires a dialog id');
  }

  if (runtime.signal.aborted) {
    return (
      <section className="dialog-empty" role="status">
        Подготавливаем переписку…
      </section>
    );
  }

  return (
    <Room
      key={runtime.scope.sessionId + ':' + dialogId}
      device={device}
      runtime={runtime}
      id={dialogId}
    />
  );
}
