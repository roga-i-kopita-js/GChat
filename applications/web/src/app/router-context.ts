import { BackendApi } from '@gchat/backend-api';

import { DeviceError } from '../shared/device';
import { deviceContext } from '../shared/device/router-context';

export { deviceContext } from '../shared/device/router-context';

import { createContext, RouterContextProvider } from 'react-router';

import { AdminResults } from '../features/administration/results';
import type { ApplicationDevice } from './device';

export interface RouteUser {
  sub: string;
  sid: string;
  role: 'user' | 'admin';
}

export const userContext = createContext<RouteUser>();

export const adminResultsContext = createContext<AdminResults>(new AdminResults());

export function createApplicationContext(device: ApplicationDevice): () => RouterContextProvider {
  const adminResults = new AdminResults();

  return (): RouterContextProvider => {
    const context = new RouterContextProvider();

    context.set(deviceContext, device);
    context.set(adminResultsContext, adminResults);

    return context;
  };
}

export function applicationDevice(context: Readonly<RouterContextProvider>): ApplicationDevice {
  const value = context.get(deviceContext);

  if (!isApplicationDevice(value)) {
    throw new DeviceError('INTEGRATION_ERROR');
  }

  return value;
}

function isApplicationDevice(
  value: import('../shared/device/router-context').HttpSession,
): value is ApplicationDevice {
  return value.http instanceof BackendApi;
}
