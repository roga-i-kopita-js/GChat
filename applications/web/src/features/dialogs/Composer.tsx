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
import { useNavigationProtection } from '../../shared/navigation-protection';
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
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const [panel, setPanel] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const current = useRef(draft.text);
  const revision = useRef(draft.revision);
  const dirty = useRef(false);
  const tail = useRef(Promise.resolve());
  const conflictRef = useRef(false);
  const mounted = useRef(true);

  const save = useCallback(async (): Promise<void> => {
    const run = async (): Promise<void> => {
      if (!dirty.current) {
        return;
      }

      if (conflictRef.current) {
        throw new StorageError('STORAGE_CONFLICT');
      }

      const value = current.current;

      try {
        const next = await runtime.draft(id, value, revision.current);

        revision.current = next;

        if (current.current === value) {
          dirty.current = false;
        }
      } catch (cause) {
        if (cause instanceof StorageError && cause.code === 'STORAGE_CONFLICT') {
          conflictRef.current = true;

          if (mounted.current) {
            setConflict(true);
          }
        }

        if (mounted.current) {
          setError(dialogError(cause));
        }

        throw cause;
      }
    };
    const task = (async () => {
      try {
        await tail.current;
      } catch {
        // A failed save must not prevent the next draft from being saved.
      }

      return run();
    })();

    tail.current = task;

    return task;
  }, [runtime, id]);

  useNavigationProtection({
    dirty: (): boolean => dirty.current,
    flush: save,
    discard: (): void => {
      dirty.current = false;
      conflictRef.current = false;
    },
  });
  useEffect((): (() => void) => runtime.protectDraft(save), [runtime, save]);
  useEffect((): void => {
    if (draft.revision > revision.current && !dirty.current) {
      revision.current = draft.revision;
      current.current = draft.text;
      setText(draft.text);
    }
  }, [draft.text, draft.revision]);
  useEffect((): (() => void) => {
    if (!dirty.current) {
      return (): void => {};
    }

    const timer = setTimeout((): void => {
      void (async () => {
        try {
          return await save();
        } catch (cause) {}
      })();
    }, 300);

    return (): void => clearTimeout(timer);
  }, [text, save]);
  useEffect((): (() => void) => {
    mounted.current = true;
    const visibility = (): void => {
      if (document.visibilityState !== 'visible') {
        void (async () => {
          try {
            return await save();
          } catch (cause) {}
        })();
      }
    };
    const prepare = (): void => {
      void (async () => {
        try {
          return await save();
        } catch (cause) {}
      })();
    };

    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('gchat-prepare-update', prepare);

    return (): void => {
      mounted.current = false;
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('gchat-prepare-update', prepare);
      void (async () => {
        try {
          return await save();
        } catch (cause) {}
      })();
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

      const { record: savedRecord } = saved;

      revision.current = savedRecord.draft.revision;
      conflictRef.current = false;
      setConflict(false);
      setError('');

      if (keepMine) {
        await save();
      } else {
        const { record: savedRecord2 } = saved;

        current.current = savedRecord2.draft.text;
        setText(current.current);
        dirty.current = false;
      }
    } catch (cause) {
      setError(dialogError(cause));
    }
  }
  async function send(sticker?: string): Promise<void> {
    if (busy || conflict) {
      return;
    }

    const value = current.current;
    const validation = sticker ? null : checkText(value);

    if (validation) {
      setError(validation);

      return;
    }

    if (sticker && !isStickerId(sticker)) {
      return;
    }

    setBusy(true);
    setError('');

    try {
      await save();

      if (sticker && isStickerId(sticker)) {
        await runtime.send(id, { kind: 'sticker', sticker_id: sticker });
      } else {
        await runtime.send(id, { kind: 'text', text: value }, revision.current);
      }
    } catch (cause) {
      if (mounted.current) {
        setError(dialogError(cause));
      }
    } finally {
      const saved = await (async () => {
        try {
          return await runtime.view(id);
        } catch (cause) {
          return null;
        }
      })();

      if (mounted.current) {
        if (saved) {
          const { record: savedRecord3 } = saved;

          revision.current = savedRecord3.draft.revision;
          const { record: savedRecord4 } = saved;

          current.current = savedRecord4.draft.text;
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
            if (event.key === 'Escape') {
              closePanel();
            }
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
    </div>
  );
}
