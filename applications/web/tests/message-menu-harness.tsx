import '../src/shared/ui/tokens.css';
import '../src/style.css';
import '../src/features/dialogs/dialogs.css';

import { type JSX, useCallback, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { MessageMenu } from '../src/features/dialogs/MessageMenu';
import { messageSchema } from '../src/shared/dialogs/model';

function Harness(): JSX.Element {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [edited, setEdited] = useState(false);
  const close = useCallback(
    (restoreFocus: boolean): void => {
      if (restoreFocus) {
        anchor?.focus({ preventScroll: true });
      }

      setAnchor(null);
    },
    [anchor],
  );

  return (
    <>
      <input aria-label="Черновик" />
      <div aria-label="Лента" style={{ height: 200, overflow: 'auto' }}>
        <button
          style={{ marginTop: 50 }}
          onClick={(event): void => setAnchor(event.currentTarget)}
          onPointerDown={(event): void => {
            const target = event.currentTarget;

            setTimeout((): void => setAnchor(target), 500);
          }}
        >
          Тестовое сообщение
        </button>
        <div style={{ height: 500 }} />
      </div>
      <button>Вне меню</button>
      {edited && <p>Редактирование открыто</p>}
      {anchor && (
        <MessageMenu
          anchor={anchor}
          close={close}
          edit={(): void => {
            setEdited(true);
            close(false);
          }}
        />
      )}
    </>
  );
}

function FocusHarness(): JSX.Element {
  const params = new URLSearchParams(location.search);
  const kind = params.get('message');
  const own = !params.has('peer');
  const readonly = params.has('readonly');
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [notice, setNotice] = useState('');
  const [message, setMessage] = useState(() =>
    messageSchema.parse({
      message_id: '00000000-0000-4000-8000-000000000001',
      dialog_id: '00000000-0000-4000-8000-000000000002',
      client_message_id: '00000000-0000-4000-8000-000000000003',
      sender_id: '00000000-0000-4000-8000-000000000004',
      sequence: 1,
      created_at: '2026-11-15T12:32:00.000Z',
      content:
        kind === 'sticker'
          ? { kind: 'sticker', sticker_id: 'animal-pals-v1-cat' }
          : {
              kind: 'text',
              text:
                kind === 'long'
                  ? 'Очень длинное сообщение с переносами и деталями встречи.\n'.repeat(80)
                  : 'Встречаемся завтра в 18:00?\nhttps://example.org/meet https://example.net/info',
            },
      status: 'read',
      reply: null,
      actions_verified: true,
      ...(kind === 'forward'
        ? {
            forward: {
              author: { id: '00000000-0000-4000-8000-000000000005', display_name: 'Анна' },
            },
          }
        : {}),
    }),
  );
  const close = useCallback(
    (restoreFocus: boolean): void => {
      if (restoreFocus && anchor?.isConnected) {
        anchor.focus({ preventScroll: true });
      }

      setAnchor(null);
    },
    [anchor],
  );

  return (
    <div
      style={{
        minHeight: '100dvh',
        background: 'var(--ui-canvas-background)',
        color: 'var(--ui-text)',
        fontFamily: 'var(--ui-font-family)',
      }}
    >
      <header style={{ padding: 'var(--ui-space-4)', background: 'var(--ui-surface)' }}>
        Анна Морозова
      </header>
      <div
        className="dialog-feed-wrapper"
        aria-label="Лента"
        style={{ height: 'var(--ui-size-440)', display: 'block', flex: 'none', overflow: 'auto' }}
      >
        <div style={{ height: params.has('top') ? 'var(--ui-space-4)' : 'var(--ui-size-180)' }} />
        <div className={'dialog-message-row' + (own ? ' own' : '')}>
          <div className="dialog-message-container">
            <article
              className="dialog-message"
              tabIndex={0}
              aria-label="Исходное сообщение"
              onPointerDown={(event): void => {
                if (event.pointerType === 'touch') {
                  const target = event.currentTarget;

                  setTimeout(() => setAnchor(target), 500);
                }
              }}
              onContextMenu={(event): void => {
                event.preventDefault();
                setAnchor(event.currentTarget);
              }}
              onKeyDown={(event): void => {
                if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                  event.preventDefault();
                  setAnchor(event.currentTarget);
                }
              }}
            >
              {message.content.kind === 'text' ? message.content.text : 'Стикер: Кот'}
            </article>
            <button type="button" onClick={(event) => setAnchor(event.currentTarget)}>
              Действия сообщения
            </button>
          </div>
        </div>
        <div style={{ height: 'var(--ui-size-560)' }} />
      </div>
      <input aria-label="Черновик" />
      <button type="button">Вне меню</button>
      {notice && <p role="status">{notice}</p>}
      {anchor && (
        <MessageMenu
          anchor={anchor}
          close={close}
          message={message}
          own={own}
          copied={() => setNotice('Скопировано')}
          canReact={!readonly}
          reply={
            readonly
              ? undefined
              : () => {
                  setNotice('Ответ открыт');
                  close(false);
                }
          }
          forward={() => {
            setNotice('Пересылка открыта');
            close(false);
          }}
          edit={
            own && !readonly && message.content.kind === 'text' && !message.forward
              ? () => {
                  setNotice('Редактирование открыто');
                  close(false);
                }
              : undefined
          }
          react={async (emoji) => {
            if (params.has('reaction-error')) {
              throw new Error('Reaction failed');
            }

            setMessage((current) => ({
              ...current,
              own_reaction_states: [
                ...current.own_reaction_states.filter((cell) => cell.emoji !== emoji),
                {
                  emoji,
                  selected: !current.own_reaction_states.some(
                    (cell) => cell.emoji === emoji && cell.selected,
                  ),
                  version: 1,
                  last_operation_id: '00000000-0000-4000-8000-000000000006',
                },
              ],
            }));
          }}
        />
      )}
    </div>
  );
}

export function start(): void {
  createRoot(document.getElementById('root')!).render(
    new URLSearchParams(location.search).has('message') ? <FocusHarness /> : <Harness />,
  );
}
