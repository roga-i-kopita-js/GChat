/** Expected dependency failures, including transaction lock/deadlock budgets. */
export function isDatabaseUnavailable(cause: unknown): boolean {
  if (!(cause instanceof Error)) return false;

  const failure = cause.cause instanceof Error ? cause.cause : cause;
  const code = 'code' in failure && typeof failure.code === 'string' ? failure.code : '';

  return (
    /^(08|53|57P|57014|40P01|40001|55P03|ECONN|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN)/.test(code) ||
    [
      'Connection terminated unexpectedly',
      'Connection terminated',
      'Connection terminated due to connection timeout',
      'Client has encountered a connection error and is not queryable',
      'timeout exceeded when trying to connect',
      'Query read timeout',
    ].includes(failure.message)
  );
}
