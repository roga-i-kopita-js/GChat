import type { LoaderFunctionArgs } from 'react-router';
import { z } from 'zod';

import { applicationCore, userContext } from '../../app/router-context';
import { readQuery } from '../../shared/validation/request';
import { type CallHistoryModel, type HistoryFilter, historyModel } from './history-model';

/* oxlint-disable gchat/no-promise-chains -- Zod validation fallback. */
const query = z.object({ filter: z.enum(['all', 'missed']).optional().catch('all') });
/* oxlint-enable gchat/no-promise-chains */

export interface CallHistoryData {
  model: CallHistoryModel;
  filter: HistoryFilter;
  sid: string;
}

export interface CallHistoryDetailData {
  model: CallHistoryModel;
  id: string;
  sid: string;
}

async function descriptor({
  context,
  request,
}: LoaderFunctionArgs): Promise<{ model: CallHistoryModel; sid: string }> {
  const device = applicationCore(context);
  const user = context.get(userContext);
  const state = await device.session.getState({ signal: request.signal });
  const { generation } = state;

  request.signal.throwIfAborted();

  return {
    model: historyModel(device, user.sub + '/' + user.sid, user.sub, generation),
    sid: user.sid,
  };
}

export async function callHistoryLoader(args: LoaderFunctionArgs): Promise<CallHistoryData> {
  const { filter = 'all' } = readQuery(query, args.request);
  const { model, sid } = await descriptor(args);

  await model.head(filter, args.request.signal);
  args.request.signal.throwIfAborted();

  return { model, filter, sid };
}

export async function callHistoryDetailLoader(
  args: LoaderFunctionArgs,
): Promise<CallHistoryDetailData> {
  const id = z.uuid().safeParse(args.params.callId);

  if (!id.success) {
    throw new Response('Звонок не найден', { status: 404 });
  }

  const { model, sid } = await descriptor(args);
  const normalized = id.data.toLowerCase();

  await model.detail(normalized, args.request.signal);
  args.request.signal.throwIfAborted();

  return { model, id: normalized, sid };
}
