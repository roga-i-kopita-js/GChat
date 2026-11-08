// Shared diagnostic schema. No free-form values are accepted into the journal.
export const actions = new Set([
  'HTTP',
  'Fetch',
  'Storage',
  'Navigation',
  'Cancellation',
  'Login',
  'Logout',
  'State',
  'Permission',
  'microphone',
  'camera',
  'geolocation',
  'Audio',
  'Audio started',
  'Stop',
  'Settings',
  'File',
  'File metadata',
  'Retained',
  'Foreground',
  'Start',
  'Observe',
  'Sound confirmation',
]);

const codes = new Set(
  'INVALID_ARGUMENT INVALID_STATE UNSUPPORTED UNSUPPORTED_VERSION INTEGRATION_ERROR BRIDGE_UNAVAILABLE UNAUTHENTICATED PERMISSION_DENIED RESTRICTED ACCESS_LOST NOT_FOUND WRONG_TYPE BUSY CANCELLED TIMEOUT DEVICE_UNAVAILABLE ALREADY_EXISTS CONFLICT STORAGE_FULL IO_ERROR PARTIAL_FAILURE OUTCOME_UNKNOWN PUSH_UNAVAILABLE NETWORK_ERROR INVALID_CREDENTIALS FORBIDDEN RATE_LIMITED SERVICE_UNAVAILABLE SECURE_STORAGE_ERROR OPERATION_FAILED SESSION_INVALID VALIDATION_ERROR AUTH_FAILURE'.split(
    ' ',
  ),
);
const permissions = [
  'unknown',
  'unsupported',
  'prompt',
  'denied',
  'restricted',
  'granted',
  'limited',
];
const choices = {
  fetchCheck: [
    'response-clone',
    'binary-body',
    'bodyless',
    'http-error',
    'redirect-rejected',
    'response-limit',
    'foreign-origin',
    'cancelled',
    'usable-after-cancel',
  ],
  navigationCheck: [
    'native-roundtrip',
    'committed',
    'redirected',
    'loader-failed',
    'superseded',
    'blocked',
    'blocker-proceeded',
    'revision-preserved',
    'aborted-before-start',
    'completed-event',
  ],
  navigationOutcome: ['committed', 'redirected', 'blocked', 'superseded', 'failed'],
  area: ['data', 'temporary', 'cache'],
  storageCheck: [
    'root',
    'persistent-after-restart',
    'read-write',
    'usage',
    'temporary-cleared',
    'data-survives-cycle',
    'external-registry-unchanged',
  ],
  check: [
    'GET / bytes',
    'Binary body',
    'Cookie filtering',
    'HEAD without transferred body',
    '304 without transferred body',
    '204',
    'HTTP 422 preserved',
    'Redirect blocked',
    'Response limit',
    'Foreign origin',
    'Cookie rejected',
    'Auth owner',
    'Version',
    'Cancel before registration',
    'Cancel active',
    'Old cycle',
    'Resync cancels active HTTP',
    'Active duplicate rejected',
    'New cycle remains usable',
    'No session cannot use Web token',
    'Device requires session',
  ],
  permission: permissions,
  microphonePermission: permissions,
  cameraPermission: permissions,
  geolocationPermission: permissions,
  pushPermission: permissions,
  accuracy: ['full', 'reduced', 'unknown'],
  service: ['enabled', 'disabled', 'unknown'],
  settingsHint: ['appSettings', 'siteSettings'],
  kind: ['file', 'directory', 'microphone', 'sound'],
  persistence: ['persistent', 'session'],
  testStatus: ['running', 'completed', 'cancelled', 'failed', 'none'],
  testKind: ['microphone', 'sound', 'none'],
  pushAlert: ['enabled', 'disabled', 'unknown'],
  pushSound: ['enabled', 'disabled', 'unknown'],
  pushBadge: ['enabled', 'disabled', 'unknown'],
  pushDelivery: ['unavailable', 'disabled', 'enabling', 'enabled', 'error'],
};
const booleans = new Set([
  'passed',
  'completed',
  'cancelled',
  'started',
  'more',
  'audible',
  'audioOutputAvailable',
]);
const numbers = new Set([
  'revision',
  'retainedCount',
  'size',
  'count',
  'durationMs',
  'status',
  'usedBytes',
]);

export function validMetric(key, value) {
  if (booleans.has(key)) {
    return typeof value === 'boolean';
  }

  if (numbers.has(key)) {
    return Number.isSafeInteger(value) && value >= 0;
  }

  if (key === 'code' || key === 'testError') {
    return value === null || codes.has(value);
  }

  return choices[key]?.includes(value) ?? false;
}

export function safeMetrics(value) {
  return Object.fromEntries(
    Object.entries(value ?? {}).filter(([key, entry]) => validMetric(key, entry)),
  );
}

export function validateEvent(event) {
  if (!event || Array.isArray(event) || typeof event !== 'object') {
    return false;
  }

  if (Object.keys(event).sort().join(',') !== 'action,eventId,metrics,phase,runId') {
    return false;
  }

  if (typeof event.runId !== 'string' || typeof event.eventId !== 'string') {
    return false;
  }

  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  if (
    !uuid.test(event.runId) ||
    !uuid.test(event.eventId) ||
    !actions.has(event.action) ||
    !['started', 'result', 'finished', 'failed', 'state'].includes(event.phase)
  ) {
    return false;
  }

  if (!event.metrics || Array.isArray(event.metrics) || typeof event.metrics !== 'object') {
    return false;
  }

  if (Object.keys(event.metrics).length > 30) {
    return false;
  }

  return Object.entries(event.metrics).every(([key, value]) => validMetric(key, value));
}
