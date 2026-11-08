import { z } from 'zod';

import { DeviceNavigation, NavigationError, type NavigationFailure } from './navigation';

export interface NativeNavigationPort {
  addListener(
    name: string,
    callback: (data: unknown) => void,
  ): Promise<{ remove(): Promise<void> }>;
  navigationReady(value: Record<string, unknown>): Promise<void>;
  completeNavigation(value: Record<string, unknown>): Promise<void>;
}

const identity = z.object({ cycleId: z.uuid(), requestId: z.uuid() });
const command = z.strictObject({
  navigationVersion: z.literal(1),
  cycleId: z.uuid(),
  requestId: z.uuid(),
  command: z.literal('navigate'),
  args: z.strictObject({ to: z.string(), replace: z.boolean() }),
});

/** Native transport only; the router and its revision survive foreground resynchronization. */
export class NativeNavigationBinding {
  private cycle?: string;
  private generation = 0;
  private listener?: Promise<{ remove(): Promise<void> }>;
  private stopped = false;
  private readonly records = new Map<
    string,
    { fingerprint: string; promise: Promise<Record<string, unknown>> }
  >();
  private readonly completed: string[] = [];
  private readonly retired = new Set<string>();

  constructor(
    private readonly port: NativeNavigationPort,
    private readonly navigation: DeviceNavigation,
  ) {}

  async start(cycle: string): Promise<void> {
    if (this.stopped) {
      throw new NavigationError('INVALID_STATE');
    }

    if (!z.uuid().safeParse(cycle).success) {
      throw new NavigationError('INVALID_ARGUMENT');
    }

    if (this.cycle !== cycle) {
      this.generation++;
      this.records.clear();
      this.completed.length = 0;
      this.retired.clear();
      this.cycle = cycle;
    }

    const generation = this.generation;

    this.listener ??= this.port.addListener('navigationCommand', (value): void => {
      void this.receive(value);
    });

    let attached = false;

    try {
      await this.listener;
      attached = true;
      const state = await this.navigation.getState();

      if (this.stopped || generation !== this.generation) {
        throw new NavigationError('CANCELLED');
      }

      await this.port.navigationReady({
        navigationVersion: 1,
        cycleId: cycle,
        phase: 'ready',
        location: state.location,
      });
    } catch (error) {
      if (!attached && generation === this.generation) {
        this.listener = undefined;
      }

      if (!this.stopped && generation === this.generation) {
        try {
          await this.port.navigationReady({
            navigationVersion: 1,
            cycleId: cycle,
            phase: 'failed',
          });
        } catch {
          /* Original initialization failure remains authoritative. */
        }
      }

      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }

    this.stopped = true;
    this.generation++;
    this.cycle = undefined;
    this.records.clear();
    this.completed.length = 0;
    this.retired.clear();

    if (this.listener) {
      try {
        await (await this.listener).remove();
      } catch {
        /* A disconnected bridge has nothing left to detach. */
      }
    }
  }

  private failure(code: string): NavigationFailure {
    const error = new NavigationError(code);

    return {
      code: error.code,
      service: 'navigation',
      operation: 'navigate',
      message: error.message,
    };
  }

  private async receive(value: unknown): Promise<void> {
    const ids = identity.safeParse(value);

    if (!ids.success || ids.data.cycleId !== this.cycle || this.stopped) {
      return;
    }

    const cycle = this.cycle;
    const generation = this.generation;
    const requestId = ids.data.requestId;
    const parsed = command.safeParse(value);
    let response: Record<string, unknown>;

    if (!parsed.success) {
      const version = z.object({ navigationVersion: z.number() }).safeParse(value);

      response = {
        error: this.failure(
          version.success && version.data.navigationVersion !== 1
            ? 'UNSUPPORTED_VERSION'
            : 'INVALID_ARGUMENT',
        ),
      };
    } else {
      const fingerprint = JSON.stringify(parsed.data.args);
      const cached = this.records.get(requestId);

      if (this.retired.has(requestId) || this.retired.size >= 4096) {
        response = { error: this.failure('INVALID_STATE') };
      } else if (cached && cached.fingerprint !== fingerprint) {
        response = { error: this.failure('INVALID_ARGUMENT') };
      } else {
        let record = cached;

        if (!record) {
          const promise = this.navigation
            .navigateCommand(requestId, parsed.data.args.to, { replace: parsed.data.args.replace })
            .then(
              (result): Record<string, unknown> => ({ result }),
              (error: unknown): Record<string, unknown> => ({
                error: this.failure(
                  error instanceof NavigationError ? error.code : 'INTEGRATION_ERROR',
                ),
              }),
            );

          record = { fingerprint, promise };
          this.records.set(requestId, record);
          void promise.then((): void => {
            if (generation !== this.generation) {
              return;
            }

            this.completed.push(requestId);

            while (this.completed.length > 128) {
              const oldest = this.completed.shift();

              if (oldest) {
                this.records.delete(oldest);
                this.retired.add(oldest);
              }
            }
          });
        }

        response = await record.promise;
      }
    }

    if (generation !== this.generation || this.stopped) {
      return;
    }

    try {
      await this.port.completeNavigation({
        navigationVersion: 1,
        cycleId: cycle,
        requestId,
        ...response,
      });
    } catch (error) {
      if (z.object({ code: z.literal('INVALID_STATE') }).safeParse(error).success) {
        return;
      }

      if (generation === this.generation && !this.stopped) {
        try {
          await this.port.navigationReady({
            navigationVersion: 1,
            cycleId: cycle,
            phase: 'failed',
          });
        } catch {
          /* No fallback when the native bridge is disconnected. */
        }
      }
    }
  }
}
