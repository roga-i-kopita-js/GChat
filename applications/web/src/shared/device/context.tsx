import { createContext, useContext, useMemo } from 'react';

import type { DeviceBridge } from './contract';
import { DeviceStorage } from './storage';

export const DeviceContext = createContext<DeviceBridge | null>(null);

export function useDeviceBridge(): DeviceBridge {
  const bridge = useContext(DeviceContext);

  if (!bridge) {
    throw new Error('Device bridge is required');
  }

  return bridge;
}

export function useDeviceStorage(): DeviceStorage {
  const bridge = useDeviceBridge();

  return useMemo((): DeviceStorage => new DeviceStorage(bridge), [bridge]);
}
