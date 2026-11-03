import { redactText, sanitizeLogValue } from './log-sanitizer.js';

describe('Browser ticket redaction', (): void => {
  it('masks ticket fields and the subprotocol even when supplied as a plain string', (): void => {
    const ticket = 'x'.repeat(43);

    expect(redactText('gchat, ticket.' + ticket)).not.toContain(ticket);
    expect(sanitizeLogValue({ ticket, secWebSocketProtocol: 'gchat, ticket.' + ticket })).toEqual({
      ticket: '[REDACTED]',
      secWebSocketProtocol: '[REDACTED]',
    });
  });
});
