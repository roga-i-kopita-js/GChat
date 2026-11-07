import { stickerIds } from '@gchat/dialog-assets';
import { ArrowUp, Smile, X } from 'lucide-react';
import type { JSX } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  checkText,
  type DialogRecord,
  isStickerId,
  StorageError,
} from '../../shared/dialogs/model';
import { dialogError, type DialogRuntime } from '../../shared/dialogs/runtime';
import { stickers } from './stickers';

export function Composer({
  runtime,
  id,
  draft,
}: {
  runtime: DialogRuntime;
  id: string;
  draft: DialogRecord['draft'];
}): JSX.Element {
  const [text, setText] = useState(draft.text);
  const [status, setStatus] = useState('Сохранено');
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const [panel, setPanel] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const current = useRef(draft.text),
    revision = useRef(draft.revision),
    dirty = useRef(false);
  const tail = useRef(Promise.resolve());
  const conflictRef = useRef(false);
  const mounted = useRef(true);

  const save = useCallback(async (): Promise<void> => {
    const run = async (): Promise<void> => {
      if (!dirty.current) return;

      if (conflictRef.current) throw new StorageError('STORAGE_CONFLICT');

      const value = current.current;

      if (mounted.current) setStatus('Сохраняется…');

      try {
        const next = await runtime.draft(id, value, revision.current);

        revision.current = next;

        if (current.current === value) dirty.current = false;

        if (mounted.current) setStatus(dirty.current ? 'Сохраняется…' : 'Сохранено');
      } catch (cause) {
        if (cause instanceof StorageError && cause.code === 'STORAGE_CONFLICT') {
          conflictRef.current = true;

          if (mounted.current) setConflict(true);
        }

        if (mounted.current) {
          setStatus('Не сохранено');
          setError(dialogError(cause));
        }

        throw cause;
      }
    };
    const task = tail.current.catch((): void => {}).then(run);

    tail.current = task;

    return task;
  }, [runtime, id]);

  useEffect((): (() => void) => runtime.protectDraft(save), [runtime, save]);
  useEffect((): void => {
    if (draft.revision > revision.current && !dirty.current) {
      revision.current = draft.revision;
      current.current = draft.text;
      setText(draft.text);
    }
  }, [draft.text, draft.revision]);
  useEffect((): (() => void) => {
    if (!dirty.current) return (): void => {};

    const timer = setTimeout((): void => {
      void save().catch((): void => {});
    }, 300);

    return (): void => clearTimeout(timer);
  }, [text, save]);
  useEffect((): (() => void) => {
    let replay = false;
    const visibility = (): void => {
      if (document.visibilityState !== 'visible') void save().catch((): void => {});
    };
    const navigation = (event: MouseEvent): void => {
      if (
        replay ||
        !dirty.current ||
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;

      const anchor = event.target instanceof Element ? event.target.closest('a') : null;

      if (
        !(anchor instanceof HTMLAnchorElement) ||
        anchor.origin !== location.origin ||
        anchor.target === '_blank'
      )
        return;

      event.preventDefault();
      event.stopPropagation();
      void save()
        .then((): void => {
          replay = true;
          anchor.click();
          replay = false;
        })
        .catch((): void => {});
    };
    const prepare = (): void => {
      void save().catch((): void => {});
    };

    document.addEventListener('visibilitychange', visibility);
    document.addEventListener('click', navigation, true);
    window.addEventListener('gchat-prepare-update', prepare);

    return (): void => {
      mounted.current = false;
      document.removeEventListener('visibilitychange', visibility);
      document.removeEventListener('click', navigation, true);
      window.removeEventListener('gchat-prepare-update', prepare);
      void save().catch((): void => {});
    };
  }, [save]);
  useEffect((): void => {
    const textarea = field.current;

    if (textarea) {
      textarea.style.height = '44px';
      textarea.style.height = Math.min(100, textarea.scrollHeight) + 'px';
    }
  }, [text]);
  async function resolveConflict(keepMine: boolean): Promise<void> {
    try {
      const saved = await runtime.view(id);

      revision.current = saved.record.draft.revision;
      conflictRef.current = false;
      setConflict(false);
      setError('');

      if (keepMine) await save();
      else {
        current.current = saved.record.draft.text;
        setText(current.current);
        dirty.current = false;
        setStatus('Сохранено');
      }
    } catch (cause) {
      setError(dialogError(cause));
    }
  }
  async function send(sticker?: string): Promise<void> {
    if (busy || conflict) return;

    const value = current.current;
    const validation = sticker ? null : checkText(value);

    if (validation) {
      setError(validation);

      return;
    }

    if (sticker && !isStickerId(sticker)) return;

    setBusy(true);
    setError('');

    try {
      await save();

      if (sticker && isStickerId(sticker))
        await runtime.send(id, { kind: 'sticker', sticker_id: sticker });
      else await runtime.send(id, { kind: 'text', text: value }, revision.current);
    } catch (cause) {
      if (mounted.current) setError(dialogError(cause));
    } finally {
      const saved = await runtime.view(id).catch((): null => null);

      if (mounted.current) {
        if (saved) {
          revision.current = saved.record.draft.revision;
          current.current = saved.record.draft.text;
          dirty.current = false;
          setText(current.current);
        }

        setBusy(false);
        setPanel(false);
        field.current?.focus();
      }
    }
  }
  function closePanel(): void {
    setPanel(false);
    toggle.current?.focus();
  }

  return (
    <div className="dialog-composer-area">
      {error && (
        <p className="dialog-error" role="alert">
          {error}
        </p>
      )}
      {conflict && (
        <div className="draft-conflict">
          <p>Черновик изменён в другой вкладке.</p>
          <button
            onClick={(): void => {
              void resolveConflict(false);
            }}
          >
            Загрузить сохранённый
          </button>
          <button
            onClick={(): void => {
              void resolveConflict(true);
            }}
          >
            Сохранить мой вариант
          </button>
        </div>
      )}
      {panel && (
        <section
          className="dialog-stickers"
          aria-label="Стикеры"
          onKeyDown={(event): void => {
            if (event.key === 'Escape') closePanel();
          }}
        >
          <div>
            <strong>Стикеры</strong>
            <button
              type="button"
              className="dialog-icon"
              onClick={closePanel}
              aria-label="Закрыть стикеры"
            >
              <X size={20} />
            </button>
          </div>
          <div className="dialog-sticker-grid">
            {stickerIds.filter(isStickerId).map((id): JSX.Element => (
              <button
                key={id}
                type="button"
                disabled={busy || conflict}
                aria-label={'Отправить стикер: ' + stickers[id].label}
                onClick={(): void => {
                  void send(id);
                }}
              >
                <img src={stickers[id].url} width="70" height="70" alt="" />
              </button>
            ))}
          </div>
        </section>
      )}
      <form
        className="dialog-composer"
        onSubmit={(event): void => {
          event.preventDefault();
          void send();
        }}
      >
        <textarea
          ref={field}
          value={text}
          rows={1}
          placeholder="Сообщение"
          aria-label="Сообщение"
          disabled={busy || runtime.isUpdating()}
          onChange={(event): void => {
            current.current = event.target.value;
            dirty.current = true;
            setText(current.current);
            setError('');
          }}
          onKeyDown={(event): void => {
            if (
              event.key === 'Enter' &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing &&
              matchMedia('(min-width: 801px)').matches
            ) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <button
          type="button"
          ref={toggle}
          className="dialog-icon"
          aria-label="Открыть стикеры"
          aria-expanded={panel}
          onClick={(): void => setPanel(!panel)}
        >
          <Smile size={23} />
        </button>
        <button
          type="submit"
          className="dialog-send"
          disabled={busy || conflict || !text.trim()}
          aria-label="Отправить сообщение"
        >
          <ArrowUp size={23} />
        </button>
      </form>
      <span className="draft-status" role="status">
        {status}
      </span>
    </div>
  );
}
