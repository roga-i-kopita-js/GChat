import { ErrorService } from '../error/error.service.js';
import { contentValue, queryInteger } from './dialogs.validation.js';
const error = new ErrorService();

describe('Dialog request validation', (): void => {
  it('counts code points and preserves emoji and original text', (): void => {
    const text = '😀'.repeat(4000);

    expect(contentValue({ kind: 'text', text }, error)).toEqual({ kind: 'text', text });
    expect(contentValue({ kind: 'text', text: '  é 👨‍👩‍👦\n' }, error)).toEqual({
      kind: 'text',
      text: '  é 👨‍👩‍👦\n',
    });
    expect((): unknown => contentValue({ kind: 'text', text: text + 'a' }, error)).toThrow(
      expect.objectContaining({ fields: [{ field: 'content.text', code: 'INVALID' }] }),
    );
  });
  it.each(['', '  \n', '\ud800', 'x\udc00', '\ud800x'])('rejects invalid text %p', (text): void => {
    expect((): unknown => contentValue({ kind: 'text', text }, error)).toThrow();
  });
  it('accepts only the five fixed IDs and rejects extra content fields', (): void => {
    for (const animal of ['cat', 'dog', 'fox', 'bear', 'bunny'])
      expect(
        contentValue({ kind: 'sticker', sticker_id: 'animal-pals-v1-' + animal }, error).kind,
      ).toBe('sticker');

    for (const value of [
      { kind: 'sticker', sticker_id: 'arbitrary-url' },
      { kind: 'text', text: 'ok', sticker_id: 'x' },
      { kind: 'sticker', sticker_id: 'animal-pals-v1-cat', text: 'x' },
      null,
      [],
    ])
      expect((): unknown => contentValue(value, error)).toThrow();
  });
  it.each([
    '',
    '00',
    '01',
    '+1',
    '-1',
    ' 1',
    '1 ',
    '1.0',
    '1e2',
    '0x10',
    '9007199254740992',
    ['1', '2'],
  ])('strictly rejects query %p', (value): void => {
    expect((): unknown => queryInteger(value, 'sequence', 0, error)).toThrow();
  });
  it('accepts exact safe integer endpoints and enforces limit', (): void => {
    expect(queryInteger('9007199254740991', 'sequence', 0, error)).toBe(Number.MAX_SAFE_INTEGER);
    expect(queryInteger(undefined, 'limit', 30, error, 1, 100)).toBe(30);

    for (const value of ['0', '101'])
      expect((): unknown => queryInteger(value, 'limit', 30, error, 1, 100)).toThrow();
  });
});
