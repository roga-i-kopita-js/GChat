import { z } from 'zod';

import { nativePlugin } from '../native/bridge';
import { nativeRuntime } from '../native/runtime';
import type { CallOptions } from './api';
import { DeviceError } from './contract';
import { cancellable } from './events';

/** Correlation and validation stay private; media frames never enter this channel. */
export class NativeMedia {
  constructor(private readonly signal: () => AbortSignal) {}

  async releaseViews(): Promise<void> {
    const state = nativeRuntime.getSnapshot();

    if (state.phase !== 'ready' || state.mediaVersion !== 1) {
      return;
    }

    await nativePlugin.mediaCommand({
      mediaVersion: 1,
      cycleId: state.cycleId,
      requestId: crypto.randomUUID(),
      command: 'document.dispose',
      args: {},
    });
  }

  async request<T>(
    command: string,
    args: object,
    schema: z.ZodType<T>,
    options: CallOptions = {},
  ): Promise<T> {
    const state = nativeRuntime.getSnapshot();

    if (state.phase !== 'ready') {
      throw new DeviceError('BRIDGE_UNAVAILABLE');
    }

    if (!nativeRuntime.getToken()) {
      throw new DeviceError('UNAUTHENTICATED');
    }

    if (state.mediaVersion !== 1) {
      throw new DeviceError('UNSUPPORTED_VERSION');
    }

    if (options.signal?.aborted || this.signal().aborted) {
      throw new DeviceError('CANCELLED');
    }

    const requestId = crypto.randomUUID();
    const context = AbortSignal.any([
      this.signal(),
      nativeRuntime.getSignal(),
      ...(options.signal ? [options.signal] : []),
    ]);
    const cancel = (): void => {
      void (async () => {
        try {
          return await nativePlugin.mediaCommand({
            mediaVersion: 1,
            cycleId: state.cycleId,
            requestId: crypto.randomUUID(),
            command: 'cancel',
            args: { requestId },
          });
        } catch (cause) {}
      })();
    };

    context.addEventListener('abort', cancel, { once: true });

    try {
      const raw = await cancellable(
        (): Promise<unknown> =>
          nativePlugin.mediaCommand({
            mediaVersion: 1,
            cycleId: state.cycleId,
            requestId,
            command,
            args,
          }),
        { signal: context },
      );

      if (context.aborted || nativeRuntime.getSnapshot().cycleId !== state.cycleId) {
        throw new DeviceError('CANCELLED');
      }

      const envelope = z
        .strictObject({
          mediaVersion: z.literal(1),
          cycleId: z.literal(state.cycleId),
          requestId: z.literal(requestId),
          result: z.unknown().optional(),
          error: z.strictObject({ code: z.string() }).optional(),
        })
        .safeParse(raw);

      if (!envelope.success) {
        throw new DeviceError('INTEGRATION_ERROR');
      }

      if (envelope.data.error) {
        throw new DeviceError(envelope.data.error.code, { command });
      }

      const parsed = schema.safeParse(envelope.data.result);

      if (!parsed.success) {
        throw new DeviceError('INTEGRATION_ERROR');
      }

      return parsed.data;
    } catch (cause) {
      if (cause instanceof DeviceError) {
        throw cause;
      }

      const error = z.object({ code: z.string() }).safeParse(cause);

      throw new DeviceError(error.success ? error.data.code : 'BRIDGE_UNAVAILABLE', { command });
    } finally {
      context.removeEventListener('abort', cancel);
    }
  }
}

export const mediaDone = z.strictObject({ outcome: z.literal('completed') });
