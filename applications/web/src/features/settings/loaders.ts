import type { LoaderFunctionArgs } from 'react-router';

import { applicationCore } from '../../app/router-context';
import type { DeviceCore, SessionIdentity } from '../../shared/device';
import type { DeviceState, FileRef } from '../../shared/device/contract';
import { loadDeviceSettings } from '../../shared/device/load-settings';
import { deviceErrorMessage } from '../../shared/device/messages';

export interface SettingsData {
  device: DeviceCore;
  state: DeviceState | null;
  error: string | null;
  entries?: FileRef[];
}

export async function settingsProfileLoader({
  context,
  request,
}: LoaderFunctionArgs): Promise<{ device: DeviceCore; profile: SessionIdentity }> {
  const device = applicationCore(context);
  const state = await device.session.getState({ signal: request.signal });

  request.signal.throwIfAborted();

  const { identity: stateIdentity } = state ?? {};

  if (!stateIdentity) {
    throw new Response('Unauthorized', { status: 401 });
  }

  return { device, profile: stateIdentity };
}

export async function settingsLoader({
  context,
  request,
}: LoaderFunctionArgs): Promise<SettingsData> {
  const device = applicationCore(context);

  try {
    const state = await loadDeviceSettings(device, request.signal);

    return { device, state, error: null };
  } catch (cause) {
    request.signal.throwIfAborted();

    return { device, state: null, error: deviceErrorMessage(cause) };
  }
}

export async function settingsFilesLoader(args: LoaderFunctionArgs): Promise<SettingsData> {
  const data = await settingsLoader(args);
  const entries: FileRef[] = [];
  let cursor: string | null = null;

  try {
    do {
      const { device: dataDevice } = data;
      const page = await dataDevice.files.listAccesses(
        { cursor, limit: 100 },
        { signal: args.request.signal },
      );

      args.request.signal.throwIfAborted();
      const { entries: pageEntries } = page;

      entries.push(...pageEntries);
      const { nextCursor: pageNextCursor } = page;

      cursor = pageNextCursor;
    } while (cursor);

    return { ...data, entries };
  } catch (cause) {
    args.request.signal.throwIfAborted();

    return { ...data, entries, error: deviceErrorMessage(cause) };
  }
}
