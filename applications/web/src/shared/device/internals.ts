import type { JSX } from 'react';

import type { CallsClient } from '../calls/native-client';
import type { DeviceCore } from './api';
import type { BrowserCamera } from './camera-browser';
import type { NativeCamera } from './camera-native';
import { DeviceError } from './contract';
import type { StateSource } from './events';
import type { DeviceObserver } from './observer';

export interface PresentationState {
  revision: number;
  loginNavigation: 'router' | 'host';
  callControls: 'application' | 'host';
  incomingSurface: 'application' | 'host';
  callingAvailable: boolean;
  supportedEnvironment: boolean;
}

export interface DeviceInternals {
  client: CallsClient;
  observer: DeviceObserver;
  presentation: StateSource<PresentationState>;
  camera: BrowserCamera | NativeCamera;
  render(): JSX.Element;
  provider: string | null;
  confirmSessionRevoked(generation: number): Promise<void>;
}

const records = new WeakMap<object, DeviceInternals>();

export function registerDevice(device: object, record: DeviceInternals): void {
  records.set(device, record);
}

export function deviceInternals(device: object): DeviceInternals {
  const record = records.get(device);

  if (!record) {
    throw new DeviceError('INTEGRATION_ERROR');
  }

  return record;
}

export function isDevice(value: unknown): value is DeviceCore {
  return typeof value === 'object' && value !== null && records.has(value);
}
