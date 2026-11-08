import { DeviceErrorCode, type DeviceFailure } from './api';
import { DeviceError, failure } from './contract';

export function deviceFailure(cause: unknown, service: string, operation: string): DeviceError {
  const error = cause instanceof DeviceError ? cause : failure(cause);
  let code = error.code;

  if (
    typeof cause === 'object' &&
    cause !== null &&
    'code' in cause &&
    typeof cause.code === 'string'
  ) {
    code = Object.values(DeviceErrorCode).find((value): boolean => value === cause.code) ?? code;
  }

  const report: DeviceFailure = {
    code,
    service,
    operation,
    message: error.message,
    details: {
      ...(error.settingsHint === 'appSettings' ||
      error.settingsHint === 'siteSettings' ||
      error.settingsHint === 'none'
        ? { settingsHint: error.settingsHint }
        : {}),
      ...(error.outcome === 'unknown' || error.outcome === 'partial'
        ? { outcome: error.outcome }
        : {}),
      ...(error.completedIds ? { completedIds: error.completedIds } : {}),
      ...(error.destinationId ? { destinationId: error.destinationId } : {}),
    },
  };

  return new DeviceError(report);
}
