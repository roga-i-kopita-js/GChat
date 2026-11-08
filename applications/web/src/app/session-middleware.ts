import { type MiddlewareFunction, redirect } from 'react-router';

import { withFrontendUpdate } from '../shared/frontend-update-lease';
import { applicationDevice, userContext } from './router-context';

export const sessionMiddleware: MiddlewareFunction = async (
  { context, request },
  next,
): Promise<void> => {
  const device = applicationDevice(context);
  const state = await device.session.getState({ signal: request.signal });

  request.signal.throwIfAborted();

  if (!state.identity || state.status !== 'authenticated') {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/apps\/client(?=\/|$)/, '') || '/';

    throw redirect('/login?returnTo=' + encodeURIComponent(path + url.search));
  }

  context.set(userContext, {
    sub: state.identity.id,
    sid: String(state.generation),
    role: state.identity.role,
  });

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    await withFrontendUpdate(async (): Promise<void> => {
      await next();
    }, request.signal);
  } else {
    await next();
  }
};
