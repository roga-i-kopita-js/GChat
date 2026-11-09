import type { LoaderFunctionArgs } from 'react-router';
import { z } from 'zod';

import { applicationCore } from '../../app/router-context';
import type { DeviceCore } from '../../shared/device';
import { cancellable } from '../../shared/device/events';
import { dialogBootstrap } from '../../shared/dialogs/bootstrap';
import type { DialogRuntime } from '../../shared/dialogs/runtime';

export interface DialogsData {
  device: DeviceCore;
  runtime: DialogRuntime;
  dialogId: string | null;
}

export async function dialogsLoader({
  context,
  request,
  params,
}: LoaderFunctionArgs): Promise<DialogsData> {
  const dialogId = params.dialogId ?? null;

  if (dialogId && !z.string().uuid().safeParse(dialogId).success) {
    throw new Response('Not found', { status: 404 });
  }

  const device = applicationCore(context);
  const runtime = await dialogBootstrap(device).ready(request.signal);

  request.signal.throwIfAborted();
  const { listModel: runtimeListModel } = runtime;
  const local = await runtimeListModel.bind(runtime)().getState();

  request.signal.throwIfAborted();
  const { refreshList: runtimeRefreshList } = runtime;
  const list = (async () => {
    try {
      return await runtimeRefreshList.bind(runtime)();
    } catch (cause) {}
  })();

  const { items: localItems } = local ?? {};

  if (dialogId) {
    const { conversationModel: runtimeConversationModel } = runtime;
    const model = runtimeConversationModel.bind(runtime)(dialogId);
    const stored = await model.getState();

    request.signal.throwIfAborted();
    const { sync: runtimeSync } = runtime;
    const sync = runtimeSync.bind(runtime)(dialogId, true);

    const { view: storedView } = stored ?? {};

    if (!storedView?.record.dialog) {
      const { signal: runtimeSignal } = runtime;

      await cancellable((): Promise<void> => sync, { signal: request.signal }, runtimeSignal);
    }
  } else if (!localItems.length) {
    const { signal: runtimeSignal2 } = runtime;

    await cancellable((): Promise<void> => list, { signal: request.signal }, runtimeSignal2);
  }

  request.signal.throwIfAborted();

  return { device, runtime, dialogId };
}
