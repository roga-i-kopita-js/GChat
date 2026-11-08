import { BrowserFiles } from '../src/shared/device/browser-files';
import type { Args, Command, Result } from '../src/shared/device/contract';
import { resultsSchemas } from '../src/shared/device/contract';
import { DeviceStorage, StorageArea } from '../src/shared/device/storage';

export const files = new BrowserFiles((): void => {});

export const storage = new DeviceStorage({
  execute: async <C extends Command>(request: { command: C; args: Args<C> }): Promise<Result<C>> =>
    resultsSchemas[request.command].parse(
      await files.execute(request.command, request.args),
    ) as Result<C>,
});

export { StorageArea };
