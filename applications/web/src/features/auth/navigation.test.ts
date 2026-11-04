import { expect, it } from 'vitest';

import { loginDestination } from './navigation';

it('accepts an internal deep link and rejects external or looping login destinations', (): void => {
  expect(loginDestination({ from: '/admin/users/account?q=anna&offset=25#details' })).toBe(
    '/admin/users/account?q=anna&offset=25#details',
  );

  for (const from of [
    'https://example.com',
    '//example.com',
    '/\\example.com',
    '/login?next=/admin',
    5,
    null,
  ]) {
    expect(loginDestination({ from })).toBe('/calls');
  }

  expect(loginDestination(null)).toBe('/calls');
});
