export function validateEnvironment(env: Record<string, unknown>) {
  const rawPort = String(env.PORT ?? '3000');
  const port = Number(rawPort);

  if (!/^\d+$/.test(rawPort) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }

  const host = env.HOST ?? '127.0.0.1';
  if (typeof host !== 'string' || host.trim().length === 0) {
    throw new Error('HOST must be a non-empty string');
  }

  try {
    const url = new URL(String(env.DATABASE_URL ?? ''));
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname) {
      throw new Error();
    }
  } catch {
    throw new Error('DATABASE_URL must be a valid PostgreSQL connection URL');
  }

  try {
    const url = new URL(String(env.REDIS_URL ?? ''));
    if (!['redis:', 'rediss:'].includes(url.protocol) || !url.hostname
      || (url.pathname && !/^\/\d*$/.test(url.pathname)) || url.search || url.hash) {
      throw new Error();
    }
  } catch {
    throw new Error('REDIS_URL must be a valid Redis connection URL');
  }

  const prefix = env.REDIS_KEY_PREFIX;
  if (typeof prefix !== 'string' || !/^[a-zA-Z0-9:_-]+:$/.test(prefix)) {
    throw new Error('REDIS_KEY_PREFIX must be a namespace ending with a colon');
  }

  const timeouts: Record<string, number> = {};
  for (const [name, fallback] of Object.entries({
    REDIS_CONNECT_TIMEOUT_MS: 3000,
    REDIS_COMMAND_TIMEOUT_MS: 1000,
    REDIS_STARTUP_TIMEOUT_MS: 10000,
    REDLOCK_LEASE_MS: 10000,
    REDLOCK_ACQUIRE_TIMEOUT_MS: 2000,
    REDLOCK_RETRY_DELAY_MS: 100,
    REDLOCK_RETRY_JITTER_MS: 100,
    REDLOCK_EXTEND_THRESHOLD_MS: 3000,
    REDLOCK_MAX_HOLD_MS: 30000,
  })) {
    const raw = String(env[name] ?? fallback);
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < (name === 'REDLOCK_RETRY_JITTER_MS' ? 0 : 1) || value > 2147483647) {
      throw new Error(`${name} must be a positive integer up to 2147483647`);
    }
    timeouts[name] = value;
  }

  const drift = Math.ceil(timeouts.REDLOCK_LEASE_MS! * 0.01) + 2;
  if (timeouts.REDLOCK_EXTEND_THRESHOLD_MS! <= timeouts.REDIS_COMMAND_TIMEOUT_MS! + drift
    || timeouts.REDLOCK_LEASE_MS! <= timeouts.REDLOCK_EXTEND_THRESHOLD_MS! + drift) {
    throw new Error('Redlock lease and extension threshold must cover command timeout and clock drift');
  }

  return { ...env, ...timeouts, PORT: port, HOST: host };
}
