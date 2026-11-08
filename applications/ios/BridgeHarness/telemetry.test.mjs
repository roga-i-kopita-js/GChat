import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { safeMetrics, validateEvent } from './telemetry.mjs';

const event = (metrics = {}) => ({
  runId: randomUUID(),
  eventId: randomUUID(),
  action: 'State',
  phase: 'result',
  metrics,
});

test('allows actual permission, audio and file diagnostics', () => {
  assert.equal(
    validateEvent(
      event({
        microphonePermission: 'granted',
        testStatus: 'completed',
        retainedCount: 1,
        size: 128,
        persistence: 'persistent',
      }),
    ),
    true,
  );
  assert.equal(
    validateEvent({ ...event(), action: 'Sound confirmation', metrics: { audible: true } }),
    true,
  );
});
test('rejects secrets, paths, coordinates and arbitrary system text before storage', () => {
  for (const metrics of [
    { password: 'secret' },
    { token: 'secret' },
    { path: '/private/file' },
    { latitude: 34 },
    { name: 'my-file' },
    { routeName: 'my-headphones' },
    { code: 'Bearer secret' },
    { kind: 'private contents' },
  ]) {
    assert.equal(validateEvent(event(metrics)), false);
    assert.deepEqual(safeMetrics(metrics), {});
  }
});
test('rejects extra envelope fields and invalid event shapes', () => {
  for (const value of [
    null,
    [],
    { ...event(), password: 'secret' },
    { ...event(), action: 'arbitrary log' },
    { ...event(), runId: 'bad' },
    { ...event(), runId: [randomUUID()] },
    event({ size: -1 }),
    event({ count: NaN }),
    event({ completed: 'true' }),
  ]) {
    assert.equal(validateEvent(value), false);
  }
});

test('storage diagnostics carry only area names and scalar checks', () => {
  assert.equal(
    validateEvent({
      ...event(),
      action: 'Storage',
      metrics: { area: 'data', storageCheck: 'read-write', passed: true, usedBytes: 3 },
    }),
    true,
  );
  assert.equal(
    validateEvent({ ...event(), action: 'Storage', metrics: { area: '/private/data' } }),
    false,
  );
});

test('navigation diagnostics accept fixed outcomes without route contents', () => {
  assert.equal(
    validateEvent({
      ...event(),
      action: 'Navigation',
      metrics: {
        navigationCheck: 'native-roundtrip',
        passed: true,
        navigationOutcome: 'committed',
      },
    }),
    true,
  );
  assert.equal(
    validateEvent({
      ...event(),
      action: 'Navigation',
      metrics: {
        navigationCheck: '/calls?token=secret',
        passed: true,
      },
    }),
    false,
  );
});
