import type { LoaderFunctionArgs } from 'react-router';

import type { AdminResults } from '../features/administration/results';
import type { ApplicationDevice } from './device';
import { adminResultsContext, applicationDevice } from './router-context';

export interface ApplicationLoaderData {
  device: ApplicationDevice;
  adminResults: AdminResults;
}

export function applicationLoader({ context }: LoaderFunctionArgs): ApplicationLoaderData {
  return { device: applicationDevice(context), adminResults: context.get(adminResultsContext) };
}

export function loginLoader({ context }: LoaderFunctionArgs): { device: ApplicationDevice } {
  return { device: applicationDevice(context) };
}
