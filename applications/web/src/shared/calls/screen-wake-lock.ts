/** Screen lifetime follows local call ownership, independently of route components. */
export class CallScreenWakeLock {
  private callId: string | null = null;
  private sentinel: WakeLockSentinel | null = null;
  private generation = 0;
  private pending = false;

  constructor(private readonly warning: (unavailable: boolean) => void) {}

  setCall(callId: string | null): void {
    if (this.callId === callId) {
      return;
    }

    this.callId = callId;
    this.release();

    if (typeof document === 'undefined') {
      return;
    }

    document.removeEventListener('visibilitychange', this.visibility);

    if (callId) {
      document.addEventListener('visibilitychange', this.visibility);
      void this.acquire();
    }
  }

  private visibility = (): void => {
    if (document.visibilityState === 'visible') {
      void this.acquire();
    } else {
      this.release();
    }
  };

  private release(): void {
    this.generation++;
    this.pending = false;
    const sentinel = this.sentinel;

    this.sentinel = null;
    this.warning(false);

    if (sentinel) {
      void this.releaseSentinel(sentinel);
    }
  }

  private async releaseSentinel(sentinel: WakeLockSentinel): Promise<void> {
    try {
      await sentinel.release();
    } catch {
      // Cleanup must not affect the call or create an unhandled rejection.
    }
  }

  private async acquire(): Promise<void> {
    if (!this.callId || this.pending || this.sentinel || document.visibilityState !== 'visible') {
      return;
    }

    if (!navigator.wakeLock?.request) {
      this.warning(true);

      return;
    }

    const generation = this.generation;

    this.pending = true;

    try {
      const sentinel = await navigator.wakeLock.request('screen');

      if (generation !== this.generation || document.visibilityState !== 'visible') {
        await this.releaseSentinel(sentinel);

        return;
      }

      this.sentinel = sentinel;
      const { addEventListener, released } = sentinel;

      addEventListener.call(
        sentinel,
        'release',
        (): void => {
          if (this.sentinel === sentinel) {
            this.sentinel = null;
            this.warning(!!this.callId && document.visibilityState === 'visible');
          }
        },
        { once: true },
      );
      this.warning(released);

      if (released) {
        this.sentinel = null;
      }
    } catch {
      if (generation === this.generation) {
        this.warning(true);
      }
    } finally {
      if (generation === this.generation) {
        this.pending = false;
      }
    }
  }
}
