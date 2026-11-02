const sensitiveKey =
  /password|passwd|secret|token|authorization|cookie|credential|databaseurl|redisurl|connectionstring|privatekey|sdp|body|headers|apikey/i;

/** Defense in depth. Callers must still pass only safe events and metadata. */
export function redactText(value: string): string {
  return value
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, '[REDACTED_URL]')
    .replace(/\bBearer\s+[^\s"',}]+/gi, 'Bearer [REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED_TOKEN]')
    .replace(
      /\b(password|passwd|secret|token|authorization|cookie|credential|api[_-]?key)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '$1=[REDACTED]',
    )
    .slice(0, 4096);
}

export function sanitizeLogValue(
  value: unknown,
  redaction = true,
  depth = 0,
  seen = new WeakSet<object>(),
): unknown {
  if (typeof value === 'string') return redaction ? redactText(value) : value.slice(0, 4096);

  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;

  if (typeof value === 'bigint') return String(value);

  if (value === undefined) return undefined;

  if (typeof value !== 'object') return '[Unsupported]';

  // Driver messages, stacks, causes and custom properties can contain secrets.
  if (value instanceof Error && redaction) return { type: 'Error' };

  if (depth >= 5) return '[Truncated]';

  if (seen.has(value)) return '[Circular]';

  seen.add(value);

  try {
    if (Array.isArray(value))
      return value
        .slice(0, 50)
        .map((entry): unknown => sanitizeLogValue(entry, redaction, depth + 1, seen));

    const result: Record<string, unknown> = Object.create(null);
    const keys =
      value instanceof Error
        ? ['name', 'message', 'stack', ...Object.keys(value)]
        : Object.keys(value);

    for (const key of [...new Set(keys)].slice(0, 50)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);

      // Do not invoke user-defined getters or toJSON while logging.
      result[redaction ? redactText(key) : key.slice(0, 4096)] =
        redaction && sensitiveKey.test(key.replace(/[-_]/g, ''))
          ? '[REDACTED]'
          : descriptor && 'value' in descriptor
            ? sanitizeLogValue(descriptor.value, redaction, depth + 1, seen)
            : '[Accessor]';
    }

    return result;
  } finally {
    seen.delete(value);
  }
}
