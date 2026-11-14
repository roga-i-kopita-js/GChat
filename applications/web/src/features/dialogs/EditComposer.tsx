import { ApiError } from '@gchat/backend-api';
import { Check, LoaderCircle, Pencil, X } from 'lucide-react';
import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';

import { checkText, type DialogMessage } from '../../shared/dialogs/model';
import { dialogError, type DialogRuntime } from '../../shared/dialogs/runtime';
import { useNavigationProtection } from '../../shared/navigation-protection';
import { Button } from '../../shared/ui';

export function EditComposer({
  runtime,
  id,
  message,
  close,
  canSend,
}: {
  runtime: DialogRuntime;
  id: string;
  message: DialogMessage;
  close(): void;
  canSend: boolean;
}): JSX.Element {
  const initial = message.content.kind === 'text' ? message.content.text : '';
  const [text, setText] = useState(initial);
  const [base, setBase] = useState(message);
  const [actual, setActual] = useState<DialogMessage | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [unknown, setUnknown] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const mounted = useRef(true);
  const running = useRef(false);
  const operation = useRef<{ id: string; text: string; version: number } | null>(null);
  const active = (): boolean => mounted.current && !runtime.signal.aborted;
  const held = useNavigationProtection({
    dirty: (): boolean =>
      busy || unknown || text !== (base.content.kind === 'text' ? base.content.text : initial),
    discard: close,
  });

  useEffect((): (() => void) => {
    mounted.current = true;
    field.current?.focus();
    field.current?.setSelectionRange(initial.length, initial.length);

    return (): void => {
      mounted.current = false;
    };
  }, []);

  useEffect((): void => {
    const textarea = field.current;

    if (!textarea) {
      return;
    }

    textarea.style.height = 'auto';
    const style = getComputedStyle(textarea);
    const border =
      Number.parseFloat(style.borderTopWidth) + Number.parseFloat(style.borderBottomWidth);

    textarea.style.height =
      Math.min(Number.parseFloat(style.maxHeight), textarea.scrollHeight + border) + 'px';
  }, [text]);

  function finish(): void {
    if (!active()) {
      return;
    }

    const composer = field.current
      ?.closest('.dialog-room')
      ?.querySelector<HTMLTextAreaElement>('.dialog-composer textarea');

    close();
    requestAnimationFrame((): void => {
      if (!runtime.signal.aborted && composer?.isConnected) {
        composer.focus();
      }
    });
  }

  async function reconcile(expected = base): Promise<void> {
    const current = await runtime.messageGet(id, message.message_id);
    const {
      last_edit_id: currentLast_edit_id1,
      version: currentVersion2,
      content: currentContent3,
    } = current;

    if (!active()) {
      return;
    }

    if (
      currentLast_edit_id1 === operation.current?.id ||
      (currentVersion2 === expected.version &&
        currentContent3.kind === 'text' &&
        currentContent3.text === operation.current?.text)
    ) {
      if (text !== operation.current?.text) {
        setBase(current);
        setActual(null);
        setUnknown(false);
        operation.current = null;
        setError('Предыдущая правка сохранена. Новый текст ещё не сохранён.');
      } else {
        finish();
      }

      return;
    }

    setUnknown(false);

    if (currentVersion2 !== expected.version) {
      setActual(current);
      setError('Сообщение уже изменено. Сравните версии перед сохранением.');
    } else {
      setError('Правка не сохранена. Можно повторить сохранение.');
    }
  }

  async function save(applyMine = false): Promise<void> {
    if (running.current || !canSend || held || (unknown && !applyMine)) {
      return;
    }

    const validation = checkText(text);

    if (validation) {
      setError(validation);

      return;
    }

    if (actual && !applyMine) {
      return;
    }

    const expected = applyMine && actual ? actual : base;

    if (applyMine) {
      setBase(expected);
      setActual(null);
      operation.current = null;
    }

    if (
      !operation.current ||
      operation.current.text !== text ||
      operation.current.version !== expected.version
    ) {
      operation.current = { id: crypto.randomUUID(), text, version: expected.version };
    }

    running.current = true;
    setBusy(true);
    setError('');

    try {
      await runtime.edit(id, expected, text, operation.current.id);
      finish();
    } catch (cause) {
      if (!active()) {
        return;
      }

      if (
        cause instanceof ApiError &&
        cause.status < 500 &&
        cause.code !== 'MESSAGE_VERSION_CONFLICT'
      ) {
        setError(dialogError(cause));
      } else {
        setUnknown(true);

        try {
          await reconcile(expected);
        } catch {
          if (active()) {
            setError(
              'Результат сохранения неизвестен. Проверьте соединение и состояние сообщения.',
            );
          }
        }
      }
    } finally {
      running.current = false;

      if (active()) {
        setBusy(false);
      }
    }
  }

  async function check(): Promise<void> {
    if (running.current) {
      return;
    }

    running.current = true;
    setBusy(true);

    try {
      await reconcile();
    } catch (cause) {
      if (active()) {
        setError(dialogError(cause));
      }
    } finally {
      running.current = false;

      if (active()) {
        setBusy(false);
      }
    }
  }

  return (
    <div className="dialog-composer-area dialog-edit" aria-label="Редактирование сообщения">
      <div className="dialog-edit-preview">
        <span className="dialog-edit-symbol" aria-hidden="true">
          <Pencil size={20} />
        </span>
        <div className="dialog-edit-reference">
          <span className="dialog-edit-title">Редактирование</span>
          <span className="dialog-edit-original">{initial}</span>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="dialog-edit-cancel"
          aria-label="Отмена"
          title="Отменить редактирование"
          disabled={busy}
          onClick={finish}
        >
          <X size={20} aria-hidden="true" />
        </Button>
      </div>
      {error && (
        <p className="dialog-error" role="alert">
          {error}
        </p>
      )}
      {actual && (
        <div className="draft-conflict">
          <p>Актуальный текст:</p>
          <p className="dialog-message-text">
            {actual.content.kind === 'text'
              ? actual.content.text
              : 'Сообщение недоступно для редактирования'}
          </p>
          <Button
            disabled={busy || held || !canSend || !text.trim()}
            onClick={(): void => {
              void save(true);
            }}
          >
            Применить мой текст
          </Button>
        </div>
      )}
      {unknown && (
        <Button
          variant="secondary"
          disabled={busy}
          onClick={(): void => {
            void check();
          }}
        >
          Проверить сохранение
        </Button>
      )}
      <form
        className="dialog-composer"
        onSubmit={(event): void => {
          event.preventDefault();
          void save();
        }}
      >
        <textarea
          ref={field}
          value={text}
          rows={1}
          aria-label="Текст сообщения"
          disabled={busy || held}
          onChange={(event): void => {
            setText(event.target.value);
            setError('');
          }}
          onKeyDown={(event): void => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) {
              return;
            }

            if (event.key === 'Escape' && !busy) {
              event.preventDefault();
              finish();
            }

            if (
              event.key === 'Enter' &&
              !event.ctrlKey &&
              !event.altKey &&
              !event.metaKey &&
              (event.shiftKey || matchMedia('(min-width: 801px)').matches)
            ) {
              event.preventDefault();

              if (!event.repeat) {
                void save();
              }
            }
          }}
        />
        <Button
          type="submit"
          size="icon"
          className="dialog-send"
          aria-label="Сохранить"
          title="Сохранить изменения"
          aria-busy={busy}
          disabled={busy || held || !canSend || unknown || !!actual || !text.trim()}
        >
          {busy ? (
            <LoaderCircle size={23} className="dialog-edit-spinner" aria-hidden="true" />
          ) : (
            <Check size={25} aria-hidden="true" />
          )}
        </Button>
      </form>
    </div>
  );
}
