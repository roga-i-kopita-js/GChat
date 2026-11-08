import { DeviceError } from './contract';

export type Block = 'microphone' | 'camera' | 'geolocation' | 'audio' | 'push' | 'files';

interface Change {
  revision: number;
  changed: Block[];
  timedOut: boolean;
}

/** Revisions, rather than a consume-once event queue, close the read/wait race. */
export class DeviceChanges {
  revision = 0;
  private last = new Map<Block, number>();
  private pending?: {
    after: number;
    resolve(value: Change): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
  };

  touch(...blocks: Block[]): void {
    this.revision++;

    for (const block of blocks) {
      this.last.set(block, this.revision);
    }

    if (this.pending && this.pending.after < this.revision) {
      const pending = this.pending;

      clearTimeout(pending.timer);
      this.pending = undefined;
      pending.resolve(this.read(pending.after, false));
    }
  }

  private read(after: number, timedOut: boolean): Change {
    return {
      revision: this.revision,
      changed: [...this.last]
        .filter(([, revision]): boolean => revision > after)
        .map(([block]): Block => block),
      timedOut,
    };
  }

  wait(after: number, timeout: number): Promise<Change> {
    if (after > this.revision) {
      return Promise.reject(new DeviceError('INVALID_ARGUMENT'));
    }

    if (this.pending) {
      return Promise.reject(new DeviceError('BUSY'));
    }

    if (after < this.revision) {
      return Promise.resolve(this.read(after, false));
    }

    return new Promise((resolve, reject): void => {
      const timer = setTimeout((): void => {
        this.pending = undefined;
        resolve(this.read(after, true));
      }, timeout);

      this.pending = { after, resolve, reject, timer };
    });
  }

  reset(): void {
    this.cancel();
    this.revision = 0;
    this.last.clear();
  }

  cancel(): void {
    if (!this.pending) {
      return;
    }

    clearTimeout(this.pending.timer);
    this.pending.reject(new DeviceError('CANCELLED'));
    this.pending = undefined;
  }
}
