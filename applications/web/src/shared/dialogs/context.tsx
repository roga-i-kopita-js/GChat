import { createContext, useContext } from 'react';

import type { DialogRuntime } from './runtime';

export interface BootstrapState {
  runtime: DialogRuntime | null;
  error: string | null;
  retry(): void;
}

export const DialogBootstrapContext = createContext<BootstrapState>({
  runtime: null,
  error: null,
  retry: (): void => {},
});

export function useBootstrap(): BootstrapState {
  return useContext(DialogBootstrapContext);
}
