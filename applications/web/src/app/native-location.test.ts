import { describe, expect, it } from 'vitest';

import { resolveNativeLocation } from './native-location';

const resolver = (to: string): string => resolveNativeLocation(to, 'https://gchat.test');

describe('app native route policy', (): void => {
  it('rejects external URLs, unknown paths, unsafe segments and secret/invalid queries', (): void => {
    for (const to of [
      'https://evil.test/calls',
      '//evil.test/calls',
      '/calls#secret',
      '/settings/../calls',
      '/settings/%2e%2e/calls',
      '/settings%2fgeneral/audio',
      '/calls?access_token=secret',
      '/calls?group=x',
      '/calls?group=all&group=all',
      '/unknown',
      '/admin/users?offset=24',
      '/admin/users?status=other',
      '/login?returnTo=%2Flogin',
      '/login?serverUrl=https://evil.test',
    ]) {
      expect((): string => resolveNativeLocation(to, 'https://gchat.test'), to).toThrow();
    }
  });
  it('normalizes allowed filters and preserves supported internal routes', (): void => {
    expect(resolver('/admin/users?q=%20anna%20&status=all&offset=0')).toBe('/admin/users?q=anna');
    expect(resolver('/admin/users?offset=0025')).toBe('/admin/users?offset=25');
    expect(resolver('/login?returnTo=%2Fcalls')).toBe('/login?returnTo=%2Fcalls');
    expect(resolver('/dialogs/' + crypto.randomUUID())).toMatch(/^\/dialogs\//);
  });
});
