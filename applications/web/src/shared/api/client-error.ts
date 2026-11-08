export class ClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryAfter = 0,
  ) {
    super(message);
  }
}
