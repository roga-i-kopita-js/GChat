import type { MessageDto } from '../dialogs/dialogs.dto.js';

export function dialogPushPayload(message: MessageDto, apns: boolean, senderName?: string): object {
  const name = senderName?.trim();
  const title = name && [...name].length <= 80 ? name : 'GChat';
  const meta = {
    type: 'dialog.message',
    dialog_id: message.dialog_id,
    message_id: message.message_id,
    sender_id: message.sender_id,
    sequence: message.sequence,
  };
  const build = (body: string): object =>
    apns
      ? { aps: { alert: { title, body }, sound: 'default' }, ...meta }
      : { ...meta, title, body };
  const body = message.content.kind === 'text' ? message.content.text : 'Стикер';
  const budget = apns ? 4096 : 3000;

  if (Buffer.byteLength(JSON.stringify(build(body))) <= budget) {
    return build(body);
  }

  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  let prefix = '';

  for (const { segment } of segmenter.segment(body)) {
    if (Buffer.byteLength(JSON.stringify(build(prefix + segment + '…'))) > budget) {
      break;
    }

    prefix += segment;
  }

  return build(prefix + '…');
}
