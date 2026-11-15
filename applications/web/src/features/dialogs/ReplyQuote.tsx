import type { JSX } from 'react';

import { isStickerId, type ReplyInfo } from '../../shared/dialogs/model';
import { stickers } from './stickers';

export function ReplyQuote({
  reply,
  jump,
  variant = 'message',
}: {
  reply: ReplyInfo;
  jump?(): void;
  variant?: 'message' | 'composer';
}): JSX.Element {
  const className = 'dialog-reply-quote' + (variant === 'composer' ? ' composer' : '');
  const content = (
    <>
      {reply.content.kind === 'sticker' && isStickerId(reply.content.sticker_id) && (
        <img src={stickers[reply.content.sticker_id].url} width="36" height="36" alt="" />
      )}
      <span className="dialog-reply-copy">
        <strong title={reply.sender_display_name}>{reply.sender_display_name}</strong>
        <span>{reply.content.kind === 'text' ? reply.content.text : 'Стикер'}</span>
      </span>
    </>
  );

  return jump ? (
    <button
      type="button"
      className={className}
      aria-label="Перейти к исходному сообщению"
      onClick={jump}
    >
      {content}
    </button>
  ) : (
    <div className={className}>{content}</div>
  );
}
