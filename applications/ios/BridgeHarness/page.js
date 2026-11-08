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
      const response = await native('httpRequest', {
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

      if (response.result?.status !== 204) {
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

      if (change.timedOut) {
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

  if (response.error) {
    throw Object.assign(new Error(), { code: response.error.code });
  }

  return response.result;
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
  const passed =
    response.cycleId === request.cycleId &&
    response.requestId === request.requestId &&
    (expectedError
      ? response.error?.code === expectedError
      : response.result?.status === expectedStatus);

  report(label, { passed, status: response.result?.status, code: response.error?.code });

  return response;
};

async function checkHTTP() {
  const response = await check('GET / bytes', envelope('/api/bridge-fixture/bytes'), 200);

  report('Binary body', { passed: response.result?.bodyBase64 === 'AAEC/w==' });
  report('Cookie filtering', {
    passed: !response.result?.headers.some(([name]) => /^set-cookie2?$/i.test(name)),
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

  report('State', {
    revision: state.revision,
    microphone: state.microphone,
    camera: state.camera,
    geolocation: state.geolocation,
    audioTest: state.audio.test,
    push: state.push,
    retainedCount: state.files.retainedCount,
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
    const result = await command('audio.test.start', { kind: button.dataset.test });

    testId = result.testId;
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

  if (picked.outcome === 'cancelled') {
    report('File', { cancelled: true });

    return;
  }

  for (const entry of picked.entries) {
    const metadata = await command('file.stat', { id: entry.ref.id });

    report('File metadata', {
      kind: metadata.ref.kind,
      size: metadata.size,
      persistence: metadata.ref.persistence,
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

    verify('persistent-after-restart', read.dataBase64 === 'AAH/');
    // Clean up only our own prior fixture identified within the Data root.
    const list = await command('directory.list', {
      directoryId: roots.data.id,
      cursor: null,
      limit: 200,
    });
    const entry = list.entries.find(
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
    const file = await command('file.create', { directoryId: folder.ref.id, name: 'fixture.bin' });
    const write = await command('file.write.begin', {
      fileId: file.ref.id,
      mode: 'replace',
      expectedVersion: null,
    });

    await command('file.write.chunk', { writeId: write.writeId, offset: 0, dataBase64: 'AAH/' });
    await command('file.write.commit', { writeId: write.writeId });
    const read = await command('file.read', { fileId: file.ref.id, offset: 0, length: 8 });

    verify('read-write', read.dataBase64 === 'AAH/' && read.eof, { area });
    const usage = await command('storage.getUsage', { area });

    verify('usage', usage.usedBytes >= 3 && usage.quotaBytes === null, {
      area,
      usedBytes: usage.usedBytes,
    });

    if (area === 'data') {
      persistent = file.ref.id;
      localStorage.setItem(
        'gchat.storage-smoke',
        JSON.stringify({ id: persistent, directory: folder.ref.id, name }),
      );
    } else if (area === 'temporary') {
      temporary = file.ref.id;
    } else {
      await command('file.remove', { id: folder.ref.id, recursive: true });
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

  verify('data-survives-cycle', read.dataBase64 === 'AAH/');
  const after = await command('file.access.list', { cursor: null, limit: 200 });

  verify('external-registry-unchanged', original.entries.length === after.entries.length);
}
document.querySelector('#storage').onclick = run('Storage', checkStorage);
document.querySelector('#retained').onclick = run('Retained', async () => {
  const list = await command('file.access.list', { cursor: null, limit: 20 });

  report('Retained', { count: list.entries.length, more: list.nextCursor !== null });

  for (const ref of list.entries) {
    const metadata = await command('file.access.restore', { id: ref.id });

    report('File metadata', {
      kind: metadata.ref.kind,
      size: metadata.size,
      persistence: metadata.ref.persistence,
    });
  }
});
async function ready() {
  bridgeReady = false;
  const capability = await native('getCapabilities');

  if (capability.httpVersion !== 1) {
    throw Object.assign(new Error(), { code: 'UNSUPPORTED_VERSION' });
  }

  cycle = crypto.randomUUID();
  await native('webReady', { bridgeVersion: 1, cycleId: cycle });
  bridgeReady = true;

  if (capability.navigationVersion === 1) {
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
