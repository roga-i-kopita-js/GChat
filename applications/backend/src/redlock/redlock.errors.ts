export type LockErrorCode = 'LOCK_ACQUIRE_FAILED' | 'LOCK_LOST' | 'LOCK_RELEASE_FAILED' | 'LOCK_SHUTTING_DOWN';

export class LockError extends Error {
  constructor(readonly code: LockErrorCode, readonly mayHaveExecuted: boolean) {
    super(code);
    this.name = 'LockError';
  }
}
