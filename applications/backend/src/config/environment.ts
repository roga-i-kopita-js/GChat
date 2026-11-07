import { parseAuthKeys } from '../auth/auth.crypto.js';
import { parsePasswordPepper } from '../auth/auth.password.js';
import { parseBrowserOrigins } from '../auth/browser-origin.js';
import { validateDatabaseUrl } from '../database/database-url.js';
import { parseDialogKeys } from '../dialogs/dialogs.crypto.js';
import { parseLogRedaction } from '../logger/logger-settings.js';
import { validateWebPushConfig } from '../push/web-push.config.js';

export function validateEnvironment(
  env: Record<string, unknown>,
): Record<string, unknown> & { LOG_REDACTION_ENABLED: boolean; PORT: number; HOST: string } {
  parseAuthKeys(env);
  parseDialogKeys(env.DIALOGS_ENCRYPTION_KEYS, env.DIALOGS_ACTIVE_KEY_ID);
  parsePasswordPepper(env.AUTH_PASSWORD_PEPPER);
  const redaction = parseLogRedaction(env.LOG_REDACTION_ENABLED);
  const rawPort = String(env.PORT ?? '3000');
  const port = Number(rawPort);

  if (!/^\d+$/.test(rawPort) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }

  const host = env.HOST ?? '127.0.0.1';

  if (typeof host !== 'string' || host.trim().length === 0) {
    throw new Error('HOST must be a non-empty string');
  }

  validateDatabaseUrl(env.DATABASE_URL);

  try {
    const url = new URL(String(env.REDIS_URL ?? ''));

    if (
      !['redis:', 'rediss:'].includes(url.protocol) ||
      !url.hostname ||
      (url.pathname && !/^\/\d*$/.test(url.pathname)) ||
      url.search ||
      url.hash
    ) {
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
    DIRECT_CALLS_RINGING_TIMEOUT_SECONDS: 60,
    DIRECT_CALLS_CONNECTING_TIMEOUT_SECONDS: 30,
    DIRECT_CALLS_RECONNECT_TIMEOUT_SECONDS: 30,
    DIRECT_CALLS_HEARTBEAT_TIMEOUT_SECONDS: 30,
    AUTH_ACCESS_TOKEN_TTL_SECONDS: 120,
    AUTH_LOGIN_WINDOW_MS: 300000,
    AUTH_LOGIN_MAX_FAILURES: 5,
    AUTH_REFRESH_WINDOW_MS: 60000,
    AUTH_REFRESH_MAX_OPERATIONS: 10,
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

    if (
      !/^\d+$/.test(raw) ||
      !Number.isSafeInteger(value) ||
      value < (name === 'REDLOCK_RETRY_JITTER_MS' ? 0 : 1) ||
      value > 2147483647
    ) {
      throw new Error(`${name} must be a positive integer up to 2147483647`);
    }

    timeouts[name] = value;
  }

  let turnUrls: unknown;

  try {
    turnUrls = JSON.parse(String(env.DIRECT_CALLS_TURN_URLS ?? ''));
  } catch {
    throw new Error('DIRECT_CALLS_TURN_URLS must be a JSON array of TURN URLs');
  }

  if (
    !Array.isArray(turnUrls) ||
    !turnUrls.length ||
    !turnUrls.every(
      (url: unknown): boolean => typeof url === 'string' && /^turns?:[^\s]+$/.test(url),
    )
  )
    throw new Error('DIRECT_CALLS_TURN_URLS must contain TURN URLs');

  if (
    typeof env.DIRECT_CALLS_TURN_SHARED_SECRET !== 'string' ||
    !env.DIRECT_CALLS_TURN_SHARED_SECRET.trim()
  )
    throw new Error('DIRECT_CALLS_TURN_SHARED_SECRET is required');

  const rawApnsEnabled = String(env.APNS_ENABLED ?? 'true');

  if (!['true', 'false'].includes(rawApnsEnabled))
    throw new Error('APNS_ENABLED must be true or false');

  const apnsEnabled = rawApnsEnabled === 'true';

  if (apnsEnabled) {
    for (const name of ['APNS_TEAM_ID', 'APNS_KEY_ID', 'APNS_PRIVATE_KEY_FILE', 'APNS_BUNDLE_ID']) {
      if (typeof env[name] !== 'string' || !env[name].trim())
        throw new Error(name + ' is required');
    }

    if (!['sandbox', 'production'].includes(String(env.APNS_ENVIRONMENT)))
      throw new Error('APNS_ENVIRONMENT must be sandbox or production');
  }

  const drift = Math.ceil(timeouts.REDLOCK_LEASE_MS! * 0.01) + 2;

  if (
    timeouts.REDLOCK_EXTEND_THRESHOLD_MS! <= timeouts.REDIS_COMMAND_TIMEOUT_MS! + drift ||
    timeouts.REDLOCK_LEASE_MS! <= timeouts.REDLOCK_EXTEND_THRESHOLD_MS! + drift
  ) {
    throw new Error(
      'Redlock lease and extension threshold must cover command timeout and clock drift',
    );
  }

  return {
    ...env,
    ...timeouts,
    SIGNALING_BROWSER_ORIGINS: parseBrowserOrigins(env.SIGNALING_BROWSER_ORIGINS),
    DIRECT_CALLS_TURN_URLS: turnUrls,
    APNS_ENABLED: apnsEnabled,
    WEB_PUSH_ENABLED: validateWebPushConfig(env),
    LOG_REDACTION_ENABLED: redaction,
    PORT: port,
    HOST: host,
  };
}
