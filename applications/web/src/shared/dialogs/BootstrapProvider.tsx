import type { JSX, ReactNode } from 'react';
import { useSyncExternalStore } from 'react';

import { useDevice } from '../device/react';
import { dialogBootstrap } from './bootstrap';
import { DialogBootstrapContext as Context } from './context';
import { NotificationIntents } from './notification-intents';

export function BootstrapProvider({ children }: { children: ReactNode }): JSX.Element {
  const bootstrap = dialogBootstrap(useDevice());
  const state = useSyncExternalStore(bootstrap.subscribe, bootstrap.getSnapshot);

  return (
    <Context value={{ ...state, retry: bootstrap.retry }}>
      <NotificationIntents />
      {children}
    </Context>
  );
}
