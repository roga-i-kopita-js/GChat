import './dialogs.css';

import { ArrowDown, ArrowLeft, Check, CheckCheck, MessageCircle, Phone } from 'lucide-react';
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
import { DialogModelEvent } from '../../shared/dialogs/live-models';
import { type DialogMessage, isStickerId, type PendingMessage } from '../../shared/dialogs/model';
import { dialogError, type DialogRuntime, type DialogView } from '../../shared/dialogs/runtime';
import { Avatar, Button, PageHeader, Skeleton, Text } from '../../shared/ui';
import { useCalls } from '../calls/CallsProvider';
import { Composer } from './Composer';
import { time } from './format';
import type { DialogsData } from './loaders';
import { stickers } from './stickers';

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
  const { ongoing, setPerson, setMobile } = useCalls();
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

  useEffect((): (() => void) => {
    runtime.select(id, false);

    return (): void => runtime.select(null);
  }, [runtime, id]);
  const data = result.view;
  const loadingPeer = !data?.record.dialog && result.status !== 'error' && !data?.error;

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
          <Feed runtime={runtime} id={id} data={data} report={setError} />
        ) : (
          <div className="dialog-empty" role="status">
            <MessageCircle size={36} />
            <h3>{emptyHistoryMessage}</h3>
            {data.record.permissions?.can_send && <p>Напишите первое сообщение</p>}
          </div>
        )}
        {data.record.permissions?.can_send ? (
          <Composer key={id} runtime={runtime} id={id} draft={data.record.draft} />
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
          disabled={!data?.record.dialog}
          onClick={(): void => {
            const dialog = data?.record.dialog;

            if (!dialog) {
              return;
            }

            if (!ongoing) {
              void (async () => {
                try {
                  return await device.calls.dismissEnded();
                } catch (cause) {}
              })();
              setPerson({ id: dialog.peer_id, display_name: dialog.peer_display_name });
            }

            setMobile(true);
            void navigate('/calls');
          }}
        >
          <Phone size={19} />
        </Button>
      </PageHeader>
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
}: {
  runtime: DialogRuntime;
  id: string;
  data: DialogView;
  report(value: string): void;
}): JSX.Element {
  const list = useRef<VListHandle>(null);
  const sticky = useRef(true);
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

  function acknowledge(): void {
    const last = data.messages.at(-1)?.sequence ?? 0;

    runtime.shown(id, last, sticky.current);
  }
  useLayoutEffect((): void => {
    const handle = list.current;

    if (!handle) {
      return;
    }

    if (!initialized.current) {
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
    } else if (sticky.current && !shifted) {
      handle.scrollToIndex(items.length - 1, { align: 'end' });
    } else if (data.messages.length > previousCount.current && !shifted) {
      setNewMessages(true);
    }

    previousFirst.current = data.messages[0]?.message_id;
    previousCount.current = data.messages.length;
    acknowledge();
  }, [data.messages.length, data.messages.at(-1)?.message_id, data.record.outbox.length]);
  useEffect(
    (): (() => void) => (): void => {
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

          if (offset < 100) {
            void loadOlder();
          }
        }}
        onResize={(): void => {
          if (sticky.current) {
            list.current?.scrollToIndex(items.length - 1, { align: 'end' });
          }
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
              <article
                className={'dialog-message' + (item.content.kind === 'sticker' ? ' sticker' : '')}
              >
                <Content content={item.content} />
                <div className="dialog-message-meta">
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
                            return await runtime.resend(id, item.client_message_id);
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

  return <Room key={dialogId} device={device} runtime={runtime} id={dialogId} />;
}
