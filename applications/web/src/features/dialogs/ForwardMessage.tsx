import { ApiError } from '@gchat/backend-api';
import { type JSX, useEffect, useState } from 'react';
import { Link, useFetcher } from 'react-router';

import type { DialogMessage } from '../../shared/dialogs/model';
import { dialogError, type DialogRuntime, ForwardFailure } from '../../shared/dialogs/runtime';
import { Button, Modal } from '../../shared/ui';
import type { ForwardRecipient } from './forward-recipients';

export function ForwardMessage({
  message: initial,
  runtime,
  close,
}: {
  message: DialogMessage;
  runtime: DialogRuntime;
  close(): void;
}): JSX.Element {
  const fetcher = useFetcher<{ recipients: ForwardRecipient[]; error?: string }>();
  const [message, setMessage] = useState(initial);
  const [query, setQuery] = useState('');
  const [person, setPerson] = useState<ForwardRecipient | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ForwardFailure | null>(null);
  const [error, setError] = useState('');
  const [target, setTarget] = useState<string | null>(null);

  useEffect(() => {
    void fetcher.load('/dialogs/forward-recipients');
  }, []);
  async function send(): Promise<void> {
    if (!person || busy || target) {
      return;
    }

    setBusy(true);
    setError('');

    try {
      if (failure) {
        await runtime.resend(failure.targetId, failure.clientId);
        setTarget(failure.targetId);
      } else {
        setTarget(await runtime.forward(message.dialog_id, message, person.id));
      }
    } catch (cause) {
      if (cause instanceof ForwardFailure) {
        setFailure(cause);
        setError(dialogError(cause.reason));
      } else {
        setError(
          cause instanceof Error && cause.message === 'SOURCE_CHANGED'
            ? 'Исходное сообщение изменилось. Обновите предпросмотр.'
            : dialogError(cause),
        );
      }
    } finally {
      setBusy(false);
    }
  }
  const conflict =
    !failure || (failure.reason instanceof ApiError && failure.reason.status === 409);

  const submitLabel = failure ? 'Проверить и повторить' : 'Переслать';

  return (
    <Modal title="Переслать сообщение" close={close}>
      {target ? (
        <p role="status">
          Переслано: {person?.display_name}. <Link to={'/dialogs/' + target}>Открыть диалог</Link>
        </p>
      ) : (
        <>
          <div className="dialog-forward-preview">
            {message.content.kind === 'text' ? message.content.text : 'Стикер'}
          </div>
          {person ? (
            <p>
              Получатель: <strong>{person.display_name}</strong>
            </p>
          ) : (
            <>
              <label>
                Найти получателя
                <input value={query} onChange={(event) => setQuery(event.currentTarget.value)} />
              </label>
              {!fetcher.data && <p role="status">Загружаем получателей…</p>}
              {fetcher.data?.error && (
                <>
                  <p role="alert">{fetcher.data.error}</p>
                  <Button
                    variant="secondary"
                    onClick={() => void fetcher.load('/dialogs/forward-recipients')}
                  >
                    Повторить загрузку
                  </Button>
                </>
              )}
              <div className="dialog-forward-people">
                {fetcher.data?.recipients
                  .filter((item) =>
                    item.display_name.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
                  )
                  .map((item) => (
                    <Button
                      key={item.id}
                      variant="secondary"
                      disabled={!item.can_send}
                      onClick={() => setPerson(item)}
                    >
                      {item.display_name}
                      {!item.can_send ? ' — отправка недоступна' : ''}
                    </Button>
                  ))}
              </div>
            </>
          )}
          {error && <p role="alert">{error}</p>}
          {error && conflict && (
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void (async () => {
                  try {
                    if (failure) {
                      await runtime.discardRejectedForward(failure.targetId, failure.clientId);
                    }

                    const fresh = await runtime.messageGet(message.dialog_id, message.message_id);

                    setMessage(fresh);
                    setFailure(null);
                    setError('');
                  } catch (cause) {
                    setError(dialogError(cause));
                  } finally {
                    setBusy(false);
                  }
                })();
              }}
            >
              Обновить предпросмотр
            </Button>
          )}
          <div className="modal-actions">
            <Button variant="secondary" onClick={close}>
              Отмена
            </Button>
            {person && (
              <Button disabled={busy || (!!error && conflict)} onClick={() => void send()}>
                {busy ? 'Отправляем…' : submitLabel}
              </Button>
            )}
          </div>
        </>
      )}
    </Modal>
  );
}
