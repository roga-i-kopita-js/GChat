import { NavigationError } from '../shared/device/navigation';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** App-owned route policy shared by native navigation and future route loaders. */
export function resolveNativeLocation(to: string, origin: string, allowLogin = true): string {
  const invalid = (): never => {
    throw new NavigationError('INVALID_ARGUMENT');
  };

  if (
    typeof to !== 'string' ||
    new TextEncoder().encode(to).length > 4096 ||
    !to.startsWith('/') ||
    to.startsWith('//') ||
    /[\\#\x00-\x1f\x7f]/.test(to)
  ) {
    return invalid();
  }

  const path = to.split('?')[0];

  if (/%(?:2f|5c|00)/i.test(path)) {
    return invalid();
  }

  let decoded: string;

  try {
    decoded = decodeURIComponent(path);
  } catch {
    return invalid();
  }

  if (
    decoded.includes('//') ||
    decoded.split('/').some((part): boolean => part === '.' || part === '..')
  ) {
    return invalid();
  }

  const fixed = [
    '/',
    '/login',
    '/calls',
    '/admin',
    '/admin/users',
    '/dialogs',
    '/settings',
    '/settings/general',
    ...['microphone', 'audio', 'push', 'camera', 'geolocation', 'files'].map(
      (part): string => '/settings/general/' + part,
    ),
  ];
  let entityValue;

  if (decoded.startsWith('/dialogs/')) {
    entityValue = decoded.slice(9);
  } else if (decoded.startsWith('/admin/users/')) {
    entityValue = decoded.slice(13);
  } else {
    entityValue = '';
  }

  const entity = entityValue;

  if ((!fixed.includes(decoded) && !uuid.test(entity)) || (!allowLogin && decoded === '/login')) {
    return invalid();
  }

  const url = new URL(to, origin);
  const keys = [...url.searchParams.keys()];
  let allowedValue: string[];

  if (decoded === '/login') {
    allowedValue = ['serverUrl', 'returnTo'];
  } else if (decoded === '/calls') {
    allowedValue = ['group'];
  } else if (decoded === '/admin/users' || decoded.startsWith('/admin/users/')) {
    allowedValue = ['q', 'status', 'offset'];
  } else {
    allowedValue = [];
  }

  const allowed = allowedValue;

  if (new Set(keys).size !== keys.length || keys.some((key): boolean => !allowed.includes(key))) {
    return invalid();
  }

  const query = new URLSearchParams(url.search);
  const server = query.get('serverUrl');

  if (server !== null) {
    const selected = new URL(server);

    if (
      selected.origin !== origin ||
      selected.protocol !== 'https:' ||
      selected.username ||
      selected.password ||
      selected.pathname !== '/' ||
      selected.search ||
      selected.hash
    ) {
      return invalid();
    }

    query.set('serverUrl', selected.origin);
  }

  const returnTo = query.get('returnTo');

  if (returnTo !== null) {
    query.set('returnTo', resolveNativeLocation(returnTo, origin, false));
  }

  const group = query.get('group');

  if (group !== null && group !== 'all' && !uuid.test(group)) {
    return invalid();
  }

  const q = query.get('q');

  if (q !== null) {
    const trimmed = q.trim();

    if (trimmed.length > 80 || /[\x00-\x1f\x7f]/.test(trimmed)) {
      return invalid();
    }

    if (trimmed) {
      query.set('q', trimmed);
    } else {
      query.delete('q');
    }
  }

  const status = query.get('status');

  if (status !== null) {
    if (!['all', 'active', 'disabled'].includes(status)) {
      return invalid();
    }

    if (status === 'all') {
      query.delete('status');
    }
  }

  const offset = query.get('offset');

  if (offset !== null) {
    const number = Number(offset);

    if (!/^\d+$/.test(offset) || !Number.isSafeInteger(number) || number % 25 !== 0) {
      return invalid();
    }

    if (number === 0) {
      query.delete('offset');
    } else {
      query.set('offset', String(number));
    }
  }

  query.sort();
  const search = query.toString();

  return decoded + (search ? '?' + search : '');
}
