import type { JSX } from 'react';

import { type DialogMessage, isStickerId } from '../../shared/dialogs/model';
import { time } from './format';
import { MessageDeliveryStatus } from './MessageDeliveryStatus';
import { ReplyQuote } from './ReplyQuote';
import { stickers } from './stickers';

export function MessageMenuPreview({
  message,
  own,
  read = message.status === 'read',
}: {
  message: DialogMessage;
  own: boolean;
  read?: boolean;
}): JSX.Element {
  let content: JSX.Element;

  if (message.content.kind === 'text') {
    content = <span className="dialog-message-text">{message.content.text}</span>;
  } else if (isStickerId(message.content.sticker_id)) {
    content = (
      <img
        src={stickers[message.content.sticker_id].url}
        width="132"
        height="132"
        alt={'Стикер: ' + stickers[message.content.sticker_id].label}
      />
    );
  } else {
    content = <span>Стикер</span>;
  }

  return (
    <div className={'dialog-message-menu-preview' + (own ? ' own' : '')}>
      <div
        className={'dialog-message' + (message.content.kind === 'sticker' ? ' sticker' : '')}
        role="note"
        aria-label="Выбранное сообщение"
      >
        {message.forward && (
          <div className="dialog-forward-label">
            Переслано{message.forward.author ? ' от ' + message.forward.author.display_name : ''}
          </div>
        )}
        {message.reply && <ReplyQuote reply={message.reply} />}
        {content}
        <div className="dialog-message-meta">
          {message.edited_at && <span>изменено</span>}
          <time dateTime={message.created_at}>{time(message.created_at)}</time>
          {own && <MessageDeliveryStatus state={read ? 'read' : 'sent'} />}
        </div>
      </div>
    </div>
  );
}
