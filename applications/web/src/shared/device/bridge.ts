import { z } from 'zod';

import { embedded, nativePlugin } from '../native/bridge';
import { nativeRuntime } from '../native/runtime';
import { BrowserDevice, type BrowserDeviceHost } from './browser';
import {
  type Args,
  argsSchemas,
  type Command,
  commandExists,
  type DeviceBridge,
  DeviceError,
  failure,
  type Result,
  resultsSchemas,
} from './contract';

/** A document-scoped dispatcher; environment selection never occurs in UI. */
export class CommandBridge implements DeviceBridge {
  private browser?: BrowserDevice;
  private epoch = 0;
  private nativeWait?: string;

  constructor(host: BrowserDeviceHost) {
    if (!embedded) this.browser = new BrowserDevice(host);
  }

  reset(): void {
    this.epoch++;
    this.nativeWait = undefined;
    this.browser?.reset();
  }

  stopAudio(): void {
    this.browser?.stop();
  }

  execute<C extends Command>(request: { command: C; args: Args<C> }): Promise<Result<C>>;
  async execute(request: { command: Command; args: unknown }): Promise<unknown> {
    if (!commandExists(request.command))
      throw new DeviceError('INVALID_ARGUMENT', { command: request.command });

    const parsed = argsSchemas[request.command].safeParse(request.args);

    if (!parsed?.success) throw new DeviceError('INVALID_ARGUMENT', { command: request.command });

    const epoch = this.epoch;

    let deadline: ReturnType<typeof setTimeout> | undefined;

    try {
      const operation = (async (): Promise<unknown> => {
        let result: unknown;

        if (this.browser) result = await this.browser.execute(request.command, parsed.data);
        else {
          const state = nativeRuntime.getSnapshot();

          if (state.phase !== 'ready' || !nativeRuntime.getToken())
            throw new DeviceError('UNAUTHENTICATED');

          if (request.command === 'device.changes.cancel' && !this.nativeWait)
            return { outcome: 'completed' };

          if (request.command === 'device.changes.wait' && this.nativeWait)
            throw new DeviceError('BUSY');

          const requestId =
            request.command === 'device.changes.cancel'
              ? (this.nativeWait ?? crypto.randomUUID())
              : crypto.randomUUID();

          if (request.command === 'device.changes.wait') this.nativeWait = requestId;

          const pending = nativePlugin.executeDeviceCommand({
            deviceBridgeVersion: 1,
            cycleId: state.cycleId,
            requestId,
            command: request.command,
            args: parsed.data,
          });
          let raw: unknown;

          try {
            raw = await pending;
          } finally {
            if (request.command === 'device.changes.wait' && this.nativeWait === requestId)
              this.nativeWait = undefined;
          }

          const response = z
            .strictObject({
              deviceBridgeVersion: z.literal(1),
              cycleId: z.literal(state.cycleId),
              requestId: z.literal(requestId),
              result: z.unknown().optional(),
              error: z
                .strictObject({
                  code: z.string(),
                  settingsHint: z.string().optional(),
                  outcome: z.string().optional(),
                  completedIds: z.array(z.string()).optional(),
                  destinationId: z.string().optional(),
                })
                .optional(),
            })
            .parse(raw);

          if (state.cycleId !== nativeRuntime.getSnapshot().cycleId)
            throw new DeviceError('CANCELLED');

          if (response.error) throw new DeviceError(response.error.code, response.error);

          result = response.result;
        }

        if (epoch !== this.epoch) throw new DeviceError('CANCELLED');

        return resultsSchemas[request.command].parse(result);
      })();
      const interactive = [
        'permission.request',
        'call.prepareOutgoing',
        'push.enable',
        'file.pick',
        'directory.pick',
        'file.saveAs',
        'file.export',
        'audio.output.select',
        'file.access.restore',
        'device.changes.wait',
      ].includes(request.command);

      if (interactive) return await operation;

      return await Promise.race([
        operation,
        new Promise<never>((_resolve, reject): void => {
          deadline = setTimeout((): void => {
            const modifying = [
              'file.create',
              'directory.create',
              'file.write.commit',
              'file.copy',
              'file.move',
              'file.rename',
              'file.remove',
            ].includes(request.command);

            reject(new DeviceError(modifying ? 'OUTCOME_UNKNOWN' : 'TIMEOUT'));
          }, 30000);
        }),
      ]);
    } catch (error) {
      if (error instanceof z.ZodError)
        throw new DeviceError('INTEGRATION_ERROR', { command: request.command });

      if (error instanceof DeviceError || error instanceof DOMException) {
        const cause = failure(error);

        throw new DeviceError(cause.code, { ...cause.details, command: request.command });
      }

      const native = z.object({ code: z.string() }).safeParse(error);

      throw new DeviceError(native.success ? native.data.code : 'BRIDGE_UNAVAILABLE', {
        command: request.command,
      });
    } finally {
      clearTimeout(deadline);
    }
  }
}
