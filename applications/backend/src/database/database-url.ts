export function validateDatabaseUrl(value: unknown): string {
  try {
    if (typeof value !== 'string') throw new Error();
    const url = new URL(value);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname) throw new Error();
    return value;
  } catch {
    throw new Error('DATABASE_URL must be a valid PostgreSQL connection URL');
  }
}
