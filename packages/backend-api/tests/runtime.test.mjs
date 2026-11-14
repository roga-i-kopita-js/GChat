import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import { ApiError, ApiResponseParseError, BackendApi } from '@gchat/backend-api';

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

for (const [format, Client] of [
  ['ESM', BackendApi],
  ['CommonJS', createRequire(import.meta.url)('@gchat/backend-api').BackendApi],
]) {
  test(`${format}: public exports and required baseUrl`, () => {
    assert.throws(() => new Client({}), /baseUrl/);
    assert.deepEqual(
      Object.getOwnPropertyNames(Client.prototype),
      Object.getOwnPropertyNames(BackendApi.prototype),
    );
    assert.equal(
      Object.getOwnPropertyNames(Client.prototype).filter((name) => name !== 'constructor').length,
      27,
    );
  });

  test(`${format}: base path, path escaping, query, JSON and 204`, async () => {
    const calls = [];
    const api = new Client({
      baseUrl: '/api/',
      fetch: async (...args) => {
        calls.push(args);

        return json({ user: { disabled_at: null } });
      },
    });
    const result = await api.adminGetUser({ path: { user_id: 'id /?#%' } });

    assert.equal(calls[0][0], '/api/admin/users/id%20%2F%3F%23%25');
    const { data: resultData } = result;

    assert.equal(resultData.user.disabled_at, null);
    const { status: resultStatus } = result;

    assert.equal(resultStatus, 200);
    const { headers: resultHeaders } = result;

    assert.ok(resultHeaders instanceof Headers);
    await api.adminListUsers({ query: { q: 'иван +&', limit: 5, offset: 0, status: 'all' } });
    const query = new URL(calls[1][0], 'https://test.invalid').searchParams;

    assert.equal(query.get('q'), 'иван +&');
    assert.equal(query.get('offset'), '0');
    await api.adminListUsers();
    assert.equal(calls[2][0], '/api/admin/users');
    await api.adminCreateUser({
      body: { display_name: 'Иван', group_name: 'Family', password: 'secret' },
    });
    assert.deepEqual(JSON.parse(calls[3][1].body), {
      display_name: 'Иван',
      group_name: 'Family',
      password: 'secret',
    });
    assert.equal(calls[3][1].method, 'POST');
    assert.equal(calls[3][1].headers.get('Content-Type'), 'application/json');
    const logout = new Client({
      baseUrl: 'https://example.invalid/api/',
      fetch: async (url) => {
        assert.equal(url, 'https://example.invalid/api/auth/logout');

        return new Response(null, { status: 204 });
      },
    });

    const { data: authLogoutResultData } = await logout.authLogout({
      body: { refresh_token: 'unchanged' },
    });

    assert.equal(authLogoutResultData, undefined);
  });

  test(`${format}: Bearer follows security, tokens change, clients stay isolated`, async () => {
    const headers = [];
    let token = 'first';
    let reads = 0;
    const api = new Client({
      baseUrl: '/api',
      getAccessToken: async () => {
        reads++;

        return token;
      },
      fetch: async (_url, init) => {
        headers.push(init.headers.get('Authorization'));

        return json({});
      },
    });

    await api.authLogin({ body: { login: 'ivan', password: 'password' } });
    await api.healthcheckHealth();
    assert.equal(reads, 0);
    await api.groupsList();
    token = 'second';
    await api.groupsList();
    token = undefined;
    await api.groupsList();
    assert.deepEqual(headers, [null, null, 'Bearer first', 'Bearer second', null]);
    const other = new Client({
      baseUrl: 'https://other.invalid',
      getAccessToken: () => 'other',
      fetch: async (url, init) => {
        assert.equal(url, 'https://other.invalid/groups');
        assert.equal(init.headers.get('Authorization'), 'Bearer other');

        return json({});
      },
    });

    await other.groupsList();
  });
}

for (const status of [400, 401, 403, 429, 503]) {
  test(`HTTP ${status} preserves error body and headers without retry`, async () => {
    let calls = 0;
    const body = {
      error: {
        code: 'FUTURE_CODE',
        message: 'Safe message',
        fields: [{ field: 'login', code: 'invalid' }],
      },
    };
    const api = new BackendApi({
      baseUrl: '/api',
      fetch: async () => {
        calls++;

        return json(body, status, { 'Retry-After': '30' });
      },
    });

    await assert.rejects(api.groupsList(), (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, status);
      assert.equal(error.code, 'FUTURE_CODE');
      assert.equal(error.message, 'Safe message');
      assert.deepEqual(error.body, body);
      assert.deepEqual(error.fields, body.error.fields);
      assert.equal(error.headers.get('Retry-After'), '30');

      return true;
    });
    assert.equal(calls, 1);
  });
}

test('readiness response without standard error envelope', async () => {
  const body = { status: 'error', checks: { database: 'down', redis: 'up' } };
  const api = new BackendApi({ baseUrl: '/api', fetch: async () => json(body, 503) });

  await assert.rejects(
    api.healthcheckReady(),
    (error) =>
      error instanceof ApiError &&
      error.status === 503 &&
      error.code === undefined &&
      assert.deepEqual(error.body, body) === undefined,
  );
});

for (const status of [200, 401]) {
  test(`malformed JSON keeps HTTP metadata: ${status}`, async () => {
    const api = new BackendApi({
      baseUrl: '/api',
      fetch: async () =>
        new Response('{broken', {
          status,
          headers: { 'X-Test': 'retained', 'Content-Type': 'application/json' },
        }),
    });

    await assert.rejects(api.groupsList(), (error) => {
      assert.ok(error instanceof (status === 200 ? ApiResponseParseError : ApiError));
      assert.ok(error.cause instanceof SyntaxError);
      assert.equal(error.status, status);
      assert.equal(error.headers.get('X-Test'), 'retained');

      return true;
    });
  });
}

test('network failure and abort retain identity, signals and refresh body; no retry', async () => {
  for (const failure of [
    new TypeError('network failure'),
    new DOMException('Aborted', 'AbortError'),
  ]) {
    const controller = new AbortController();

    controller.abort();
    let calls = 0;
    const body = { request_id: 'same-request-id', refresh_token: 'same-token' };
    const api = new BackendApi({
      baseUrl: '/api',
      fetch: async (_url, init) => {
        calls++;
        assert.equal(init.signal, controller.signal);
        assert.deepEqual(JSON.parse(init.body), body);

        throw failure;
      },
    });

    await assert.rejects(
      api.authRefresh({ body, signal: controller.signal }),
      (error) => error === failure,
    );
    assert.equal(calls, 1);
  }
});

test('does not validate DTO responses at runtime', async () => {
  const body = { future: 'arbitrary JSON' };
  const api = new BackendApi({ baseUrl: '/api', fetch: async () => json(body) });

  const { data: groupsListResultData } = await api.groupsList();

  assert.deepEqual(groupsListResultData, body);
});

test('HTTP error with a plain text body preserves it', async () => {
  const api = new BackendApi({
    baseUrl: '/api',
    fetch: async () => new Response('Unavailable', { status: 503 }),
  });

  await assert.rejects(
    api.healthcheckReady(),
    (error) => error instanceof ApiError && error.body === 'Unavailable',
  );
});

test('abort while reading the response remains a transport error', async () => {
  const failure = new DOMException('Aborted', 'AbortError');
  const api = new BackendApi({
    baseUrl: '/api',
    fetch: async () => ({
      status: 200,
      ok: true,
      headers: new Headers({ 'Content-Type': 'application/json' }),
      json: async () => {
        throw failure;
      },
    }),
  });

  await assert.rejects(api.groupsList(), (error) => error === failure);
});

test('dialog methods preserve numeric positions, message IDs, content and Bearer authorization', async () => {
  const calls = [];
  const api = new BackendApi({
    baseUrl: '/api',
    getAccessToken: () => 'dialog-token',
    fetch: async (...args) => {
      calls.push(args);

      return json({});
    },
  });

  await api.dialogsCreate({ body: { peer_id: 'peer' } });
  await api.dialogsSendMessage({
    path: { dialog_id: 'dialog' },
    body: { client_message_id: 'client', content: { kind: 'text', text: 'Привет 👋' } },
  });
  await api.dialogsRead({ path: { dialog_id: 'dialog' }, body: { sequence: 9007199254740991 } });
  await api.dialogsHistory({
    path: { dialog_id: 'dialog' },
    query: { after_sequence: 0, limit: 30 },
  });
  assert.equal(calls[0][0], '/api/dialogs');
  assert.equal(calls[1][0], '/api/dialogs/dialog/messages');
  assert.deepEqual(JSON.parse(calls[1][1].body), {
    client_message_id: 'client',
    content: { kind: 'text', text: 'Привет 👋' },
  });
  assert.deepEqual(JSON.parse(calls[2][1].body), { sequence: 9007199254740991 });
  const historyUrl = new URL(calls[3][0], 'https://example.invalid');

  assert.equal(historyUrl.pathname, '/api/dialogs/dialog/messages');
  assert.deepEqual(Object.fromEntries(historyUrl.searchParams), {
    after_sequence: '0',
    limit: '30',
  });
  assert.equal(new Headers(calls[1][1].headers).get('Authorization'), 'Bearer dialog-token');
});

test('call history methods encode filters/cursors and preserve nullable metadata', async () => {
  const calls = [];
  const item = {
    call_id: 'id',
    started_at: null,
    duration_seconds: null,
    outcome: 'missed',
    direction: 'incoming',
    peer_display_name: 'Анна',
  };
  const api = new BackendApi({
    baseUrl: '/api',
    getAccessToken: () => 'history-token',
    fetch: async (...args) => {
      calls.push(args);

      return json(calls.length === 1 ? { items: [item], next_cursor: null } : { item });
    },
  });
  const { data: list } = await api.callsHistoryList({
    query: { filter: 'missed', limit: 30, cursor: 'cursor+/=' },
  });

  assert.deepEqual(list, { items: [item], next_cursor: null });
  const url = new URL(calls[0][0], 'https://example.invalid');

  assert.equal(url.pathname, '/api/calls/history');
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    filter: 'missed',
    limit: '30',
    cursor: 'cursor+/=',
  });
  const { data: detail } = await api.callsHistoryGet({ path: { call_id: 'id /?#' } });

  assert.deepEqual(detail, { item });
  assert.equal(calls[1][0], '/api/calls/history/id%20%2F%3F%23');

  for (const [, options] of calls) {
    assert.equal(options.method, 'GET');
    assert.equal(new Headers(options.headers).get('Authorization'), 'Bearer history-token');
  }
});
