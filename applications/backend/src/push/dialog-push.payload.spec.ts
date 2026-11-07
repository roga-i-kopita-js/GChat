import type { MessageDto } from '../dialogs/dialogs.dto.js';
import { dialogPushPayload } from './dialog-push.payload.js';
const base: MessageDto = {
  message_id: 'aaaaaaaa-1111-4111-8111-111111111111',
  dialog_id: 'bbbbbbbb-1111-4111-8111-111111111111',
  sender_id: 'cccccccc-1111-4111-8111-111111111111',
  client_message_id: 'dddddddd-1111-4111-8111-111111111111',
  sequence: Number.MAX_SAFE_INTEGER,
  created_at: new Date(0).toISOString(),
  status: 'sent',
  content: { kind: 'text', text: 'hello' },
};

describe('Dialog push JSON budget', (): void => {
  it('keeps full short text and uses the separate alert shape', (): void => {
    expect(dialogPushPayload(base, true)).toEqual({
      aps: { alert: { title: 'GChat', body: 'hello' }, sound: 'default' },
      type: 'dialog.message',
      dialog_id: base.dialog_id,
      message_id: base.message_id,
      sender_id: base.sender_id,
      sequence: base.sequence,
    });
    expect(
      dialogPushPayload(
        { ...base, content: { kind: 'sticker', sticker_id: 'animal-pals-v1-cat' } },
        false,
      ),
    ).toEqual(expect.objectContaining({ body: 'Стикер' }));
  });
  it.each([true, false])(
    'truncates on graphemes within serialized UTF-8 budget (APNs=%s)',
    (apns): void => {
      const payload: any = dialogPushPayload(
        { ...base, content: { kind: 'text', text: '👨‍👩‍👦'.repeat(600) } },
        apns,
      );

      expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThanOrEqual(apns ? 4096 : 3000);
      const body = apns ? payload.aps.alert.body : payload.body;

      expect(body.endsWith('…')).toBe(true);
      expect(body.slice(0, -1).replaceAll('👨‍👩‍👦', '')).toBe('');
    },
  );
  it('handles one huge combining grapheme with an ellipsis', (): void => {
    const payload: any = dialogPushPayload(
      { ...base, content: { kind: 'text', text: 'x' + '́'.repeat(3999) } },
      false,
    );

    expect(payload.body).toBe('…');
  });
});
