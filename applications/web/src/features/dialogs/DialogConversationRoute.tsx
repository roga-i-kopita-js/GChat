import './dialogs.css';

import { ArrowDown, ArrowLeft, Ellipsis, MessageCircle, Phone, Reply } from 'lucide-react';
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
import {
  type DialogMessage,
  isStickerId,
  type PendingMessage,
  type ReplyInfo,
} from '../../shared/dialogs/model';
import { dialogError, type DialogRuntime, type DialogView } from '../../shared/dialogs/runtime';
import { Avatar, Button, Modal, PageHeader, Skeleton, Text } from '../../shared/ui';
import { useCalls } from '../calls/CallsProvider';
import { Composer } from './Composer';
import { EditComposer } from './EditComposer';
import { time } from './format';
import { ForwardMessage } from './ForwardMessage';
import type { DialogsData } from './loaders';
import { type MessageDeliveryState, MessageDeliveryStatus } from './MessageDeliveryStatus';
import { MessageMenu } from './MessageMenu';
import { MessageReactions } from './MessageReactions';
import { ReplyQuote } from './ReplyQuote';
import { stickers } from './stickers';
import { useMessageGestures } from './useMessageGestures';

interface SendScrollRequest {
  clientId: string;
  sequence: number;
}

function hasHistoryGap(ranges: readonly [number, number][]): boolean {
  let previousEnd: number | null = null;

  for (const [start, end] of ranges.toSorted((a, b) => a[0] - b[0])) {
    if (previousEnd !== null && start > previousEnd + 1) {
      return true;
    }

    previousEnd = Math.max(previousEnd ?? end, end);
  }

  return false;
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
function SavedContent({
  message,
  runtime,
}: {
  message: DialogMessage;
  runtime: DialogRuntime;
}): JSX.Element {
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (message.actions_verified) {
      return;
    }

    let active = true;

    void (async () => {
      try {
        await runtime.verifyMessage(message.dialog_id, message.message_id);
      } catch {
        if (active) {
          setFailed(true);
        }
      }
    })();

    return () => {
      active = false;
    };
  }, [runtime, message.message_id, message.actions_verified, retry]);

  return (
    <>
      {message.forward && (
        <div className="dialog-forward-label">
          Переслано{message.forward.author ? ' от ' + message.forward.author.display_name : ''}
        </div>
      )}
      {!message.actions_verified && (
        <small role="status">
          {failed ? (
            <button
              type="button"
              onClick={() => {
                setFailed(false);
                setRetry((value) => value + 1);
              }}
            >
              Повторить обновление сведений
            </button>
          ) : (
            'Обновляем сведения сообщения…'
          )}
        </small>
      )}
      <Content content={message.content} />
    </>
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
  const [editDirty, setEditDirty] = useState(false);
  const refreshingReply = useRef<string | null>(null);
  const [pendingReply, setPendingReply] = useState<DialogMessage | null>(null);
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

  async function replyTo(message: DialogMessage, confirmed = false): Promise<void> {
    if (editing && editDirty && !confirmed) {
      setPendingReply(message);

      return;
    }

    setPendingReply(null);
    setEditing(null);

    try {
      await runtime.chooseReply(id, {
        message_id: message.message_id,
        sequence: message.sequence,
        version: message.version,
        sender_id: message.sender_id,
        sender_display_name:
          message.sender_id === runtime.scope.accountId
            ? 'Вы'
            : (data?.record.dialog?.peer_display_name ?? 'Собеседник'),
        content: message.content,
      });
    } catch (cause) {
      if (!runtime.signal.aborted) {
        setError(dialogError(cause));
      }
    }
  }

  useEffect(() => {
    const selected = data?.record.draft.reply_to;
    const source =
      selected && data?.messages.find((message) => message.message_id === selected.message_id);

    if (
      selected &&
      source?.actions_verified &&
      source.version > selected.version &&
      data?.record.permissions?.can_send
    ) {
      const key = source.message_id + ':' + source.version;

      if (refreshingReply.current === key) {
        return;
      }

      refreshingReply.current = key;
      void (async () => {
        try {
          await runtime.chooseReply(id, {
            ...selected,
            version: source.version,
            content: source.content,
          });
        } catch (cause) {
          if (!runtime.signal.aborted) {
            setError(dialogError(cause));
          }
        } finally {
          refreshingReply.current = null;
        }
      })();
    }
  }, [data?.record.draft.reply_to, data?.messages, runtime, id]);

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
            reply={(message) => void replyTo(message)}
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
                      message.content.kind === 'text' &&
                      message.forward === null &&
                      message.actions_verified,
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
                onDirtyChange={setEditDirty}
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
      {pendingReply && (
        <Modal title="Отменить редактирование и ответить?" close={() => setPendingReply(null)}>
          <p>Несохранённая правка будет отменена. Обычный черновик сохранится.</p>
          <div className="modal-actions">
            <Button variant="secondary" onClick={() => setPendingReply(null)}>
              Продолжить редактирование
            </Button>
            <Button onClick={() => void replyTo(pendingReply, true)}>Ответить</Button>
          </div>
        </Modal>
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
  reply,
  sendScrollRequest,
  onPrepared,
}: {
  runtime: DialogRuntime;
  id: string;
  data: DialogView;
  report(value: string): void;
  edit(message: DialogMessage): void;
  reply(message: DialogMessage): void;
  sendScrollRequest: SendScrollRequest | null;
  onPrepared(clientId: string): void;
}): JSX.Element {
  const [actionMessage, setActionMessage] = useState<{
    message: DialogMessage;
    anchor: HTMLElement;
  } | null>(null);
  const [copyNotice, setCopyNotice] = useState<{ dialogId: string } | null>(null);

  useEffect(() => {
    if (!copyNotice) {
      return;
    }

    const timer = setTimeout(() => setCopyNotice(null), 3_000);

    return () => clearTimeout(timer);
  }, [copyNotice]);
  const [forwarding, setForwarding] = useState<{
    message: DialogMessage;
    anchor: HTMLElement;
  } | null>(null);
  const [jumpRequest, setJumpRequest] = useState<{ messageId: string; nonce: number } | null>(null);
  const [replyRetry, setReplyRetry] = useState<{
    pending: PendingMessage;
    reply: ReplyInfo;
  } | null>(null);
  const [replyRetryBusy, setReplyRetryBusy] = useState(false);
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const appliedJump = useRef(0);
  const selectedAction = actionMessage
    ? (data.messages.find((message) => message.message_id === actionMessage.message.message_id) ??
      actionMessage.message)
    : null;
  const closeActions = useCallback(
    (restoreFocus: boolean): void => {
      if (restoreFocus && actionMessage) {
        let target: HTMLElement | null = actionMessage.anchor;

        if (!target.isConnected) {
          target = document.getElementById('dialog-message-' + actionMessage.message.message_id);
        }

        target?.classList.remove('dialog-message-menu-source');
        target?.focus({ preventScroll: true });
      }

      setActionMessage(null);
    },
    [actionMessage],
  );
  const canSwipeReply = !!data.record.permissions?.can_read && !!data.record.permissions.can_send;
  const gestures = useMessageGestures({
    canRead: !!data.record.permissions?.can_read,
    canReply: canSwipeReply,
    blocked: !!actionMessage || !!forwarding || !!replyRetry,
    openMenu: (message, anchor) => setActionMessage({ message, anchor }),
    reply: (message) => {
      const current = data.messages.find((item) => item.message_id === message.message_id);

      if (canSwipeReply && current?.actions_verified) {
        reply(current);
      }
    },
  });
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
  async function jumpTo(messageId: string): Promise<void> {
    stopFollowing();

    try {
      if (!data.messages.some((message) => message.message_id === messageId)) {
        await runtime.revealMessage(id, messageId);
      }

      if (!runtime.signal.aborted) {
        setJumpRequest((previous) => ({ messageId, nonce: (previous?.nonce ?? 0) + 1 }));
      }
    } catch (cause) {
      if (!runtime.signal.aborted) {
        report(dialogError(cause));
      }
    }
  }
  useLayoutEffect(() => {
    if (!jumpRequest || appliedJump.current === jumpRequest.nonce) {
      return;
    }

    const index = items.findIndex(
      (item) => 'message_id' in item && item.message_id === jumpRequest.messageId,
    );

    if (index < 0) {
      return;
    }

    appliedJump.current = jumpRequest.nonce;
    list.current?.scrollToIndex(index, { align: 'center' });
    setHighlighted(jumpRequest.messageId);
    const frame = requestAnimationFrame(() =>
      document
        .getElementById('dialog-message-' + jumpRequest.messageId)
        ?.focus({ preventScroll: true }),
    );

    return () => cancelAnimationFrame(frame);
  }, [jumpRequest, data.messages]);
  useEffect(() => {
    if (!highlighted) {
      return;
    }

    const timer = setTimeout(() => setHighlighted(null), 2000);

    return () => clearTimeout(timer);
  }, [highlighted, jumpRequest]);

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
      {copyNotice?.dialogId === id && (
        <p className="dialog-action-notice" role="status">
          Скопировано
        </p>
      )}
      {forwarding && (
        <ForwardMessage
          message={forwarding.message}
          runtime={runtime}
          close={() => {
            if (forwarding.anchor.isConnected) {
              forwarding.anchor.focus({ preventScroll: true });
            }

            setForwarding(null);
          }}
        />
      )}
      {replyRetry && (
        <Modal
          title="Исходное сообщение изменилось"
          close={() => {
            if (!replyRetryBusy) {
              setReplyRetry(null);
            }
          }}
        >
          <p>Проверьте обновлённую цитату перед повторной отправкой.</p>
          <ReplyQuote reply={replyRetry.reply} />
          <p>
            {replyRetry.pending.content.kind === 'text'
              ? replyRetry.pending.content.text
              : 'Стикер'}
          </p>
          <div className="modal-actions">
            <Button
              variant="secondary"
              disabled={replyRetryBusy}
              onClick={() => setReplyRetry(null)}
            >
              Отмена
            </Button>
            <Button
              disabled={replyRetryBusy}
              onClick={() => {
                setReplyRetryBusy(true);
                void (async () => {
                  try {
                    await runtime.replaceRejectedReply(
                      id,
                      replyRetry.pending.client_message_id,
                      replyRetry.reply,
                      onPrepared,
                    );
                    setReplyRetry(null);
                  } catch (cause) {
                    if (!runtime.signal.aborted) {
                      report(dialogError(cause));
                      setReplyRetry(null);
                    }
                  } finally {
                    setReplyRetryBusy(false);
                  }
                })();
              }}
            >
              Отправить с обновлённой цитатой
            </Button>
          </div>
        </Modal>
      )}
      {actionMessage && selectedAction && (
        <MessageMenu
          anchor={actionMessage.anchor}
          close={closeActions}
          message={selectedAction}
          own={selectedAction.sender_id === runtime.scope.accountId}
          read={
            selectedAction.status === 'read' || selectedAction.sequence <= data.record.peer_read
          }
          copied={() => setCopyNotice({ dialogId: id })}
          reply={
            data.record.permissions?.can_send && selectedAction.actions_verified
              ? () => {
                  reply(selectedAction);
                  setActionMessage(null);
                }
              : undefined
          }
          canReact={!!data.record.permissions?.can_send && selectedAction.actions_verified}
          forward={
            selectedAction.actions_verified
              ? () => {
                  setForwarding({ message: selectedAction, anchor: actionMessage.anchor });
                  setActionMessage(null);
                }
              : undefined
          }
          react={async (emoji) => {
            await runtime.setReaction(id, selectedAction, emoji);
            report('');
          }}
          edit={
            selectedAction.sender_id === runtime.scope.accountId &&
            selectedAction.content.kind === 'text' &&
            selectedAction.forward === null &&
            selectedAction.actions_verified &&
            data.record.permissions?.can_send
              ? () => {
                  edit(selectedAction);
                  setActionMessage(null);
                }
              : undefined
          }
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
      {hasHistoryGap(data.record.ranges) && (
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

          const sending = !saved && (item.state === 'prepared' || item.state === 'sending');
          const swipeable =
            saved &&
            canSwipeReply &&
            item.actions_verified &&
            !actionMessage &&
            !forwarding &&
            !replyRetry;
          let deliveryState: MessageDeliveryState;

          if (saved) {
            deliveryState = read ? 'read' : 'sent';
          } else if (sending) {
            deliveryState = 'sending';
          } else if (!saved && item.state === 'rejected') {
            deliveryState = 'rejected';
          } else {
            deliveryState = 'unknown';
          }

          return (
            <div
              key={
                (saved ? item.sender_id : runtime.scope.accountId) + ':' + item.client_message_id
              }
              className={'dialog-message-row' + (own ? ' own' : '')}
            >
              <div className="dialog-message-container" data-swipe-enabled={swipeable || undefined}>
                {swipeable && (
                  <span className="dialog-message-swipe-hint" aria-hidden="true">
                    <Reply />
                  </span>
                )}
                <article
                  id={saved ? 'dialog-message-' + item.message_id : undefined}
                  className={
                    'dialog-message' +
                    (item.content.kind === 'sticker' ? ' sticker' : '') +
                    (saved && item.message_id === actionMessage?.message.message_id
                      ? ' dialog-message-menu-source'
                      : '') +
                    (saved && item.message_id === highlighted ? ' reply-target' : '')
                  }
                  tabIndex={saved && data.record.permissions?.can_read ? 0 : undefined}
                  aria-haspopup={saved && data.record.permissions?.can_read ? 'menu' : undefined}
                  onKeyDown={(event): void => {
                    if (
                      saved &&
                      data.record.permissions?.can_read &&
                      (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))
                    ) {
                      event.preventDefault();
                      setActionMessage({ message: item, anchor: event.currentTarget });
                    }
                  }}

                  onContextMenu={(event): void => {
                    if (saved && data.record.permissions?.can_read) {
                      event.preventDefault();
                      gestures.cancel();
                      setActionMessage({ message: item, anchor: event.currentTarget });
                    }
                  }}
                  onPointerDown={(event): void => {
                    if (saved) {
                      gestures.start(event, item);
                    }
                  }}
                  onClickCapture={gestures.click}
                >
                  {item.reply && (
                    <ReplyQuote
                      reply={item.reply}
                      jump={
                        saved && data.record.permissions?.can_read
                          ? () => void jumpTo(item.reply!.message_id)
                          : undefined
                      }
                    />
                  )}
                  {saved ? (
                    <SavedContent message={item} runtime={runtime} />
                  ) : (
                    <>
                      {item.operation === 'forward' && (
                        <div className="dialog-forward-label">Пересылаем…</div>
                      )}
                      <Content content={item.content} />
                    </>
                  )}
                  {saved && (
                    <MessageReactions
                      message={item}
                      runtime={runtime}
                      canSend={!!data.record.permissions?.can_send}
                      peerName={data.record.dialog?.peer_display_name ?? 'Собеседник'}
                      report={report}
                    />
                  )}
                  <div className="dialog-message-meta">
                    {saved && item.edited_at && (
                      <span aria-label="Сообщение изменено">изменено</span>
                    )}
                    <time dateTime={item.created_at}>{time(item.created_at)}</time>
                    {own && <MessageDeliveryStatus state={deliveryState} />}
                  </div>
                  {!saved && !sending && (
                    <div className="dialog-retry">
                      <span>
                        {item.state === 'rejected' ? 'Отклонено' : 'Результат неизвестен'}
                        {item.error ? ': ' + item.error : ''}
                      </span>
                      <button
                        onClick={(): void => {
                          void (async () => {
                            try {
                              if (item.reply && item.reply_conflict && item.state === 'rejected') {
                                const { version: sourceVersion, content: sourceContent } =
                                  await runtime.messageGet(id, item.reply.message_id);

                                if (!runtime.signal.aborted) {
                                  setReplyRetry({
                                    pending: item,
                                    reply: {
                                      ...item.reply,
                                      version: sourceVersion,
                                      content: sourceContent,
                                    },
                                  });
                                }
                              } else {
                                await runtime.resend(id, item.client_message_id, onPrepared);
                              }
                            } catch (cause) {
                              return report(dialogError(cause));
                            }
                          })();
                        }}
                      >
                        {item.reply_conflict ? 'Обновить цитату и повторить' : 'Повторить'}
                      </button>
                    </div>
                  )}
                </article>
                {saved && data.record.permissions?.can_read && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="dialog-message-actions"
                    aria-label="Действия сообщения"
                    onClick={(event): void => {
                      setActionMessage({ message: item, anchor: event.currentTarget });
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
