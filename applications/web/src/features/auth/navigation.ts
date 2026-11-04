/** Accept only an internal destination captured by our route guard. */
export function loginDestination(state: unknown): string {
  if (!state || typeof state !== 'object' || !('from' in state)) return '/calls';

  const from = state.from;

  if (
    typeof from !== 'string' ||
    !from.startsWith('/') ||
    from.startsWith('//') ||
    from.includes('\\')
  )
    return '/calls';

  const url = new URL(from, 'https://gchat.invalid');

  return url.pathname === '/login' ? '/calls' : url.pathname + url.search + url.hash;
}
