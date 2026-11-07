import { createContext, useContext } from 'react';

import type { DeviceBridge } from './contract';

export const DeviceContext = createContext<DeviceBridge | null>(null);

export function useDeviceBridge(): DeviceBridge {
  const bridge = useContext(DeviceContext);

  if (!bridge) throw new Error('Device bridge is required');

  return bridge;
}
