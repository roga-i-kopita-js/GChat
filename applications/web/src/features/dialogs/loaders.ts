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
  const local = await runtime.listModel().getState();

  request.signal.throwIfAborted();
  const list = runtime.refreshList().catch((): void => {});

  if (dialogId) {
    const model = runtime.conversationModel(dialogId);
    const stored = await model.getState();

    request.signal.throwIfAborted();
    const sync = runtime.sync(dialogId, true);

    if (!stored.view?.record.dialog) {
      await cancellable((): Promise<void> => sync, { signal: request.signal }, runtime.signal);
    }
  } else if (!local.items.length) {
    await cancellable((): Promise<void> => list, { signal: request.signal }, runtime.signal);
  }

  request.signal.throwIfAborted();

  return { device, runtime, dialogId };
}
