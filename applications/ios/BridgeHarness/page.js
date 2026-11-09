import { actions, safeMetrics } from './bridge-telemetry.mjs';

// Internal diagnostic client, deliberately not the public device facade.
const status = document.querySelector('#status');
const results = document.querySelector('#results');
let cycle = crypto.randomUUID();
let testId;
const lines = [];
const checks = [];
const runId = crypto.randomUUID();
const outgoing = [];
let sending = false;
let bridgeReady = false;
let observingCycle = null;
let navigationHarness;
const telemetryStatus = document.querySelector('#telemetry');

function metricsFor(value) {
  const metrics = { ...safeMetrics(value), ...safeMetrics(value?.state) };

  for (const resource of ['microphone', 'camera', 'geolocation']) {
    if (value?.[resource]) {
      metrics[resource + 'Permission'] = value[resource].permission;
    }
  }

  if (value?.geolocation) {
    Object.assign(metrics, safeMetrics(value.geolocation));
  }

  const test = value?.audio?.test ?? value?.audioTest;

  if (value?.audio || Object.hasOwn(value ?? {}, 'audioTest')) {
    if (value?.audio) {
      metrics.audioOutputAvailable = Boolean(value.audio.routeName);
    }

    metrics.testKind = test?.kind ?? 'none';
    metrics.testStatus = test?.status ?? 'none';
    metrics.testError = test?.errorCode ?? null;
  }

  if (value?.files) {
    metrics.retainedCount = value.files.retainedCount;
  }

  if (value?.push) {
    for (const key of ['permission', 'alert', 'sound', 'badge', 'delivery']) {
      metrics['push' + key[0].toUpperCase() + key.slice(1)] = value.push[key];
    }
  }

  return safeMetrics(metrics);
}
function emit(action, phase, value = {}) {
  if (!actions.has(action)) {
    return;
  }

  if (outgoing.length >= 100) {
    telemetryStatus.textContent = 'Журнал переполнен. Останови проверку до восстановления связи.';

    return;
  }

  outgoing.push({ runId, eventId: crypto.randomUUID(), action, phase, metrics: metricsFor(value) });
  void flush();
}
async function flush() {
  if (sending || !bridgeReady) {
    return;
  }

  sending = true;

  try {
    while (outgoing.length && bridgeReady) {
      const { result: responseResult } = await native('httpRequest', {
        httpVersion: 1,
        cycleId: cycle,
        requestId: crypto.randomUUID(),
        request: {
          url: '/api/bridge-fixture/manual',
          method: 'POST',
          headers: [['Content-Type', 'application/json']],
          bodyBase64: btoa(JSON.stringify(outgoing[0])),
        },
      });

      if (responseResult?.status !== 204) {
        throw new Error('DELIVERY_FAILED');
      }

      outgoing.shift();
      telemetryStatus.textContent = 'Проверяющий получает результаты. Просто нажимай кнопки.';
    }
  } catch {
    telemetryStatus.textContent = 'Результаты ждут отправки. Проверь связь со стендом.';
  } finally {
    sending = false;
  }
}
async function observeState() {
  if (!bridgeReady || observingCycle === cycle || document.visibilityState !== 'visible') {
    return;
  }

  const owner = cycle;

  observingCycle = owner;

  try {
    let state = await command('device.state.read');

    if (owner !== cycle) {
      return;
    }

    emit('Observe', 'state', state);

    while (owner === cycle && document.visibilityState === 'visible') {
      const change = await command('device.changes.wait', {
        afterRevision: state.revision,
        timeoutMs: 30000,
      });

      if (owner !== cycle) {
        return;
      }

      const { timedOut: changeTimedOut } = change;

      if (changeTimedOut) {
        continue;
      }

      state = await command('device.state.read');

      if (owner === cycle) {
        emit('Observe', 'state', state);
      }
    }
  } catch (error) {
    if (owner === cycle) {
      emit('Observe', 'failed', { code: error.code ?? 'INTEGRATION_ERROR' });
    }
  } finally {
    if (observingCycle === owner) {
      observingCycle = null;
    }
  }
}
const native = (method, options = {}) => {
  if (!window.Capacitor?.nativePromise) {
    throw new Error('BRIDGE_UNAVAILABLE');
  }

  return window.Capacitor.nativePromise('GChat', method, options);
};
const report = (label, value) => {
  if (actions.has(label)) {
    emit(label, 'result', value);
  } else if (typeof value?.passed === 'boolean') {
    emit('HTTP', 'result', { ...value, check: label });
  }

  const code = safeMetrics(value).code;

  lines.push(code ? `${label}: ${code}` : `${label}: действие завершено`);

  if (typeof value.passed === 'boolean') {
    checks.push(value.passed);
  }

  results.textContent = lines.slice(-40).join('\n');
};
const run = (label, operation) => async () => {
  const began = performance.now();

  emit(label, 'started');

  try {
    await operation();
    emit(label, 'finished', { durationMs: Math.round(performance.now() - began) });
  } catch (error) {
    // Never render raw native errors, auth responses, tokens or file paths.
    const code = safeMetrics({ code: error.code }).code ?? 'INTEGRATION_ERROR';

    emit(label, 'failed', { code, durationMs: Math.round(performance.now() - began) });
    lines.push(`${label}: действие не выполнено, проверяющий видит причину`);
    results.textContent = lines.slice(-12).join('\n');
  } finally {
    void observeState();
  }
};
const command = async (name, args = {}) => {
  const response = await native('executeDeviceCommand', {
    deviceBridgeVersion: 1,
    cycleId: cycle,
    requestId: crypto.randomUUID(),
    command: name,
    args,
  });

  const { error: responseError } = response;

  if (responseError) {
    const { error: responseError2 } = response;

    throw Object.assign(new Error(), { code: responseError2.code });
  }

  const { result: responseResult2 } = response;

  return responseResult2;
};
const envelope = (path, overrides = {}) => ({
  httpVersion: 1,
  cycleId: cycle,
  requestId: crypto.randomUUID(),
  request: { url: path, method: 'GET', headers: [], bodyBase64: null },
  ...overrides,
});
const check = async (label, request, expectedStatus, expectedError) => {
  const response = await native('httpRequest', request);
  const {
    cycleId: responseCycleId,
    requestId: responseRequestId,
    error: responseError3,
    result: responseResult3,
  } = response;
  const passed =
    responseCycleId === request.cycleId &&
    responseRequestId === request.requestId &&
    (expectedError
      ? responseError3?.code === expectedError
      : responseResult3?.status === expectedStatus);

  const { result: responseResult4, error: responseError4 } = response;

  report(label, { passed, status: responseResult4?.status, code: responseError4?.code });

  return response;
};

async function checkHTTP() {
  const response = await check('GET / bytes', envelope('/api/bridge-fixture/bytes'), 200);

  const { result: responseResult5 } = response;

  report('Binary body', { passed: responseResult5?.bodyBase64 === 'AAEC/w==' });
  const { result: responseResult6 } = response ?? {};

  report('Cookie filtering', {
    passed: !responseResult6?.headers.some(([name]) => /^set-cookie2?$/i.test(name)),
  });
  const head = envelope('/api/bridge-fixture/head-large');

  head.request.method = 'HEAD';
  await check('HEAD without transferred body', head, 200);
  await check(
    '304 without transferred body',
    envelope('/api/bridge-fixture/not-modified-large'),
    304,
  );
  await check('204', envelope('/api/bridge-fixture/empty'), 204);
  await check('HTTP 422 preserved', envelope('/api/bridge-fixture/error'), 422);
  await check('Redirect blocked', envelope('/api/bridge-fixture/redirect'), null, 'NETWORK_ERROR');
  await check('Response limit', envelope('/api/bridge-fixture/large'), null, 'UNSUPPORTED');
  await check('Foreign origin', envelope('https://example.invalid/api'), null, 'INVALID_ARGUMENT');
  const cookie = envelope('/api/bridge-fixture/bytes');

  cookie.request.headers = [['Cookie', 'test=1']];
  await check('Cookie rejected', cookie, null, 'INVALID_ARGUMENT');
  await check('Auth owner', envelope('/api/auth/login'), null, 'FORBIDDEN');
  await check(
    'Version',
    envelope('/api/bridge-fixture/bytes', { httpVersion: 2 }),
    null,
    'UNSUPPORTED_VERSION',
  );
}
document.querySelector('#http').onclick = run('HTTP', checkHTTP);
async function checkCancellation() {
  const early = envelope('/api/bridge-fixture/bytes');
  const { httpVersion, cycleId, requestId } = early;

  await native('httpCancel', { httpVersion, cycleId, requestId });
  await check('Cancel before registration', early, null, 'CANCELLED');
  const active = envelope('/api/bridge-fixture/slow');
  const pending = check('Cancel active', active, null, 'CANCELLED');

  await new Promise((resolve) => setTimeout(resolve, 150));
  await native('httpCancel', { httpVersion: 1, cycleId: cycle, requestId: active.requestId });
  await pending;
  await check(
    'Old cycle',
    envelope('/api/bridge-fixture/bytes', { cycleId: crypto.randomUUID() }),
    null,
    'CANCELLED',
  );
}
async function checkLifecycle() {
  const old = envelope('/api/bridge-fixture/slow');
  const pending = check('Resync cancels active HTTP', old, null, 'CANCELLED');

  await new Promise((resolve) => setTimeout(resolve, 150));
  await check('Active duplicate rejected', old, null, 'INVALID_ARGUMENT');
  await ready();
  await pending;
  await check('New cycle remains usable', envelope('/api/bridge-fixture/bytes'), 200);
  const protectedRequest = envelope('/api/bridge-fixture/bytes');

  protectedRequest.request.headers = [['Authorization', 'Bearer untrusted']];
  await check('No session cannot use Web token', protectedRequest, null, 'UNAUTHENTICATED');

  try {
    await command('device.state.read');
    report('Device requires session', { passed: false });
  } catch (error) {
    report('Device requires session', { passed: error.code === 'UNAUTHENTICATED' });
  }
}
document.querySelector('#cancel').onclick = run('Cancellation', checkCancellation);
document.querySelector('#login').onsubmit = (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const login = form.elements.login.value;
  const password = form.elements.password.value;

  form.elements.password.value = '';
  void run('Login', async () => {
    try {
      await native('login', { serverUrl: location.origin, login, password });
      report('Login', { completed: true });
    } finally {
      // Only the synthetic E2E password from this diagnostic form is restored.
      form.elements.password.value = form.elements.password.defaultValue;
    }
  })();
};
document.querySelector('#logout').onclick = run('Logout', async () => {
  await native('logout');
  report('Logout', { completed: true });
});
document.querySelector('#state').onclick = run('State', async () => {
  const state = await command('device.state.read');

  const {
    revision: stateRevision,
    microphone: stateMicrophone,
    camera: stateCamera,
    geolocation: stateGeolocation,
    audio: stateAudio,
    push: statePush,
    files: stateFiles,
  } = state;

  report('State', {
    revision: stateRevision,
    microphone: stateMicrophone,
    camera: stateCamera,
    geolocation: stateGeolocation,
    audioTest: stateAudio.test,
    push: statePush,
    retainedCount: stateFiles.retainedCount,
  });
});

for (const button of document.querySelectorAll('[data-resource]')) {
  button.onclick = run('Permission', async () =>
    report(
      button.dataset.resource,
      await command('permission.request', { resource: button.dataset.resource }),
    ),
  );
}

for (const button of document.querySelectorAll('[data-test]')) {
  button.onclick = run('Audio', async () => {
    const { testId: resultTestId } = await command('audio.test.start', {
      kind: button.dataset.test,
    });

    testId = resultTestId;
    report('Audio started', { kind: button.dataset.test, started: true });
  });
}

document.querySelector('#stop').onclick = run('Stop', async () => {
  if (testId) {
    await command('audio.test.stop', { testId });
  }
});
document.querySelector('#settings').onclick = run('Settings', async () => {
  await command('device.settings.open');
});
document.querySelector('#pick').onclick = run('File', async () => {
  const picked = await command('file.pick', { multiple: false, accept: [] });

  const { outcome: pickedOutcome } = picked;

  if (pickedOutcome === 'cancelled') {
    report('File', { cancelled: true });

    return;
  }

  const { entries: pickedEntries } = picked;

  for (const entry of pickedEntries) {
    const metadata = await command('file.stat', { id: entry.ref.id });

    const { ref: metadataRef, size: metadataSize } = metadata;

    report('File metadata', {
      kind: metadataRef.kind,
      size: metadataSize,
      persistence: metadataRef.persistence,
    });
  }
});
async function checkStorage() {
  const verify = (storageCheck, passed, extra = {}) => {
    report('Storage', { storageCheck, passed, ...extra });

    if (!passed) {
      throw Object.assign(new Error(), { code: 'INTEGRATION_ERROR' });
    }
  };
  const previous = JSON.parse(localStorage.getItem('gchat.storage-smoke') ?? 'null');
  const original = await command('file.access.list', { cursor: null, limit: 200 });
  const roots = {};

  for (const area of ['data', 'temporary', 'cache']) {
    roots[area] = await command('storage.getRoot', { area });
    verify('root', roots[area].kind === 'directory', {
      area,
      persistence: roots[area].persistence,
    });
  }

  if (previous) {
    const read = await command('file.read', { fileId: previous.id, offset: 0, length: 8 });

    const { dataBase64: readDataBase64 } = read;

    verify('persistent-after-restart', readDataBase64 === 'AAH/');
    // Clean up only our own prior fixture identified within the Data root.
    const list = await command('directory.list', {
      directoryId: roots.data.id,
      cursor: null,
      limit: 200,
    });
    const { entries: listEntries } = list;
    const entry = listEntries.find(
      (item) =>
        item.ref.id === previous.directory &&
        item.ref.name === previous.name &&
        /^gchat-storage-smoke-[0-9a-f-]{36}$/.test(item.ref.name),
    );

    if (entry) {
      await command('file.remove', { id: entry.ref.id, recursive: true });
    }
  }

  let persistent;
  let temporary;

  for (const area of ['data', 'temporary', 'cache']) {
    const name = 'gchat-storage-smoke-' + crypto.randomUUID();
    const folder = await command('directory.create', { directoryId: roots[area].id, name });
    const { ref: folderRef } = folder;
    const file = await command('file.create', { directoryId: folderRef.id, name: 'fixture.bin' });
    const { ref: fileRef } = file;
    const write = await command('file.write.begin', {
      fileId: fileRef.id,
      mode: 'replace',
      expectedVersion: null,
    });

    const { writeId: writeWriteId } = write;

    await command('file.write.chunk', { writeId: writeWriteId, offset: 0, dataBase64: 'AAH/' });
    const { writeId: writeWriteId2 } = write;

    await command('file.write.commit', { writeId: writeWriteId2 });
    const { ref: fileRef2 } = file;
    const read = await command('file.read', { fileId: fileRef2.id, offset: 0, length: 8 });

    const { dataBase64: readDataBase642, eof: readEof } = read;

    verify('read-write', readDataBase642 === 'AAH/' && readEof, { area });
    const usage = await command('storage.getUsage', { area });

    const { usedBytes: usageUsedBytes, quotaBytes: usageQuotaBytes } = usage;

    verify('usage', usageUsedBytes >= 3 && usageQuotaBytes === null, {
      area,
      usedBytes: usageUsedBytes,
    });

    if (area === 'data') {
      const { ref: fileRef3 } = file;

      persistent = fileRef3.id;
      const { ref: folderRef2 } = folder;

      localStorage.setItem(
        'gchat.storage-smoke',
        JSON.stringify({ id: persistent, directory: folderRef2.id, name }),
      );
    } else if (area === 'temporary') {
      const { ref: fileRef4 } = file;

      temporary = fileRef4.id;
    } else {
      const { ref: folderRef3 } = folder;

      await command('file.remove', { id: folderRef3.id, recursive: true });
    }
  }

  await ready();

  try {
    await command('file.stat', { id: temporary });
    verify('temporary-cleared', false);
  } catch (error) {
    if (error.code !== 'NOT_FOUND') {
      throw error;
    }

    verify('temporary-cleared', true);
  }

  const read = await command('file.read', { fileId: persistent, offset: 0, length: 8 });

  const { dataBase64: readDataBase643 } = read;

  verify('data-survives-cycle', readDataBase643 === 'AAH/');
  const after = await command('file.access.list', { cursor: null, limit: 200 });

  const { entries: originalEntries } = original;
  const { entries: afterEntries } = after;

  verify('external-registry-unchanged', originalEntries.length === afterEntries.length);
}
document.querySelector('#storage').onclick = run('Storage', checkStorage);
document.querySelector('#retained').onclick = run('Retained', async () => {
  const list = await command('file.access.list', { cursor: null, limit: 20 });

  const { entries: listEntries2, nextCursor: listNextCursor } = list;

  report('Retained', { count: listEntries2.length, more: listNextCursor !== null });

  const { entries: listEntries3 } = list;

  for (const ref of listEntries3) {
    const metadata = await command('file.access.restore', { id: ref.id });

    const { ref: metadataRef2, size: metadataSize2 } = metadata;

    report('File metadata', {
      kind: metadataRef2.kind,
      size: metadataSize2,
      persistence: metadataRef2.persistence,
    });
  }
});
async function ready() {
  bridgeReady = false;
  const capability = await native('getCapabilities');

  const { httpVersion: capabilityHttpVersion } = capability;

  if (capabilityHttpVersion !== 1) {
    throw Object.assign(new Error(), { code: 'UNSUPPORTED_VERSION' });
  }

  cycle = crypto.randomUUID();
  await native('webReady', { bridgeVersion: 1, cycleId: cycle });
  bridgeReady = true;

  const { navigationVersion: capabilityNavigationVersion } = capability;

  if (capabilityNavigationVersion === 1) {
    navigationHarness ??= await import('/apps/static/bridge-navigation.js');
    await navigationHarness.startNavigationHarness(cycle, (metrics) =>
      emit('Navigation', 'result', metrics),
    );
  }

  status.textContent = 'Готово. Нажимай кнопки по инструкции проверяющего.';
  void flush();
}
document.querySelector('#navigation').onclick = run('Navigation', async () => {
  if (!navigationHarness) {
    throw Object.assign(new Error(), { code: 'UNSUPPORTED_VERSION' });
  }

  await navigationHarness.runNavigationChecks();
});
document.querySelector('#heard').onclick = run('Sound confirmation', async () =>
  report('Sound confirmation', { audible: true }),
);
document.querySelector('#not-heard').onclick = run('Sound confirmation', async () =>
  report('Sound confirmation', { audible: false }),
);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    void run('Foreground', ready)();
  }
});
void run('Start', async () => {
  await ready();

  if (document.documentElement.dataset.navigationAutorun === 'true') {
    await run('Navigation', () => navigationHarness.runNavigationChecks(true))();
    await run('Fetch', () =>
      navigationHarness.runFetchChecks((metrics) => emit('Fetch', 'result', metrics)),
    )();
  }

  if (document.documentElement.dataset.storageAutorun === 'true') {
    try {
      await command('device.state.read');
    } catch (error) {
      if (error.code !== 'UNAUTHENTICATED') {
        throw error;
      }

      await native('login', {
        serverUrl: location.origin,
        login: 'anna',
        password: 'gchat-web-test-password',
      });
    }

    await run('Storage', checkStorage)();
  }

  if (document.documentElement.dataset.autorun === 'true') {
    await checkHTTP();
    await checkCancellation();
    await checkLifecycle();
    const request = envelope('/api/bridge-fixture/report');

    request.request = {
      url: '/api/bridge-fixture/report',
      method: 'POST',
      headers: [['Content-Type', 'application/json']],
      bodyBase64: btoa(
        JSON.stringify({ total: checks.length, passed: checks.filter(Boolean).length }),
      ),
    };
    await native('httpRequest', request);
  }
})();
