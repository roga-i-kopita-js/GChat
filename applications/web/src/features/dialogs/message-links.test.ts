import { describe, expect, it } from 'vitest';

import { messageLinks } from './message-links';

describe('message link addresses', () => {
  it.each([
    ['(https://example.org/a(b))', ['https://example.org/a(b)']],
    ['https://example.org/a?q=1#x,', ['https://example.org/a?q=1#x']],
    [
      'https://a.example https://b.example https://a.example',
      ['https://a.example', 'https://b.example'],
    ],
    ['«HTTPS://пример.рф/путь?x=%2f»', ['HTTPS://пример.рф/путь?x=%2f']],
    ['example.org javascript:alert(1) xxhttps://example.org', []],
    ['https:// https:/// https://a.example/path].', ['https://a.example/path']],
    [
      'https://a.example/one\nhttps://b.example/two',
      ['https://a.example/one', 'https://b.example/two'],
    ],
  ])('extracts exact addresses from %s', (text, links) => {
    expect(messageLinks(text)).toEqual(links);
  });
});
