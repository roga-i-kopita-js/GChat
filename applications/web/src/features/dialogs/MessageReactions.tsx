import { reactionCatalog, reactionGlyph } from '@gchat/dialog-assets';
import { Ellipsis } from 'lucide-react';
import { type JSX, useLayoutEffect, useRef, useState } from 'react';

import type { DialogMessage } from '../../shared/dialogs/model';
import { dialogError, type DialogRuntime } from '../../shared/dialogs/runtime';
import { Avatar, Modal } from '../../shared/ui';

export function MessageReactions({
  message,
  runtime,
  canSend,
  peerName,
  report,
}: {
  message: DialogMessage;
  runtime: DialogRuntime;
  canSend: boolean;
  peerName: string;
  report(error: string): void;
}): JSX.Element | null {
  const [viewing, setViewing] = useState(false);
  const [pending, setPending] = useState<string[]>([]);
  const details = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);

  useLayoutEffect(() => {
    if (!viewing && restoreFocus.current) {
      restoreFocus.current = false;
      details.current?.focus({ preventScroll: true });
    }
  }, [viewing]);

  function closeAuthors(): void {
    restoreFocus.current = true;
    setViewing(false);
  }

  if (!message.reactions.length) {
    return null;
  }

  return (
    <div className="dialog-message-reactions">
      {message.reactions.map(({ emoji, user_ids }) => (
        <button
          type="button"
          key={emoji}
          aria-label={
            'Реакция: ' +
            (reactionCatalog.find((item) => item.emoji === emoji)?.label ?? emoji) +
            ', ' +
            user_ids.length
          }
          aria-pressed={user_ids.includes(runtime.scope.accountId)}
          disabled={!canSend || !message.actions_verified || pending.includes(emoji)}
          onClick={() => {
            setPending((values) => [...values, emoji]);
            void (async () => {
              try {
                await runtime.setReaction(message.dialog_id, message, emoji);
              } catch (error) {
                report(dialogError(error));
              } finally {
                setPending((values) => values.filter((value) => value !== emoji));
              }
            })();
          }}
        >
          <span className="dialog-reaction-chip" aria-hidden="true">
            <span className="dialog-reaction-emoji">{reactionGlyph(emoji)}</span>
            <span className="dialog-reaction-count">{user_ids.length}</span>
          </span>
        </button>
      ))}
      <button
        ref={details}
        type="button"
        className="dialog-reaction-details"
        aria-label="Кто поставил реакции"
        onClick={() => setViewing(true)}
      >
        <span className="dialog-reaction-chip" aria-hidden="true">
          <Ellipsis />
        </span>
      </button>
      {viewing && (
        <Modal title="Реакции" close={closeAuthors}>
          <ul className="dialog-reaction-authors">
            {[...new Set(message.reactions.flatMap(({ user_ids }) => user_ids))].map((user) => {
              const name = user === runtime.scope.accountId ? 'Вы' : peerName;

              return (
                <li key={user}>
                  <Avatar name={name} seed={user} />
                  <span className="dialog-reaction-author-name">{name}</span>
                  <span className="dialog-reaction-author-emoji" aria-label="Реакции участника">
                    {message.reactions
                      .filter(({ user_ids }) => user_ids.includes(user))
                      .map(({ emoji }) => (
                        <span
                          key={emoji}
                          aria-label={
                            reactionCatalog.find((item) => item.emoji === emoji)?.label ?? emoji
                          }
                        >
                          {reactionGlyph(emoji)}
                        </span>
                      ))}
                  </span>
                </li>
              );
            })}
          </ul>
        </Modal>
      )}
    </div>
  );
}
