export interface ErrorField {
  field: string;
  code: string;
}

export interface ErrorPayload {
  message?: string;
  cause?: unknown;
}

export interface AppErrorOptions {
  status: number;
  code: string;
  message: string;
  fields?: readonly ErrorField[];
  retryAfterSeconds?: number;
  cause?: unknown;
}

export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields?: readonly ErrorField[];
  readonly retryAfterSeconds?: number;

  constructor(options: AppErrorOptions) {
    super(options.message, { cause: options.cause });
    this.name = 'AppError';
    this.status = options.status;
    this.code = options.code;
    this.fields = options.fields;

    if (options.retryAfterSeconds !== undefined) {
      if (!Number.isSafeInteger(options.retryAfterSeconds) || options.retryAfterSeconds < 0) {
        throw new RangeError('retryAfterSeconds must be a non-negative integer');
      }

      this.retryAfterSeconds = options.retryAfterSeconds;
    }
  }
}
