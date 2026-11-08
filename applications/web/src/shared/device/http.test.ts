import { afterEach, describe, expect, it, vi } from 'vitest';

import { type NativeHttpPort, NativeHttpTransport } from './http';

const origin = 'https://gchat.test';

function fixture(): {
  transport: NativeHttpTransport;
  port: NativeHttpPort;
  controller: AbortController;
  calls: Record<string, unknown>[];
} {
  const calls: Record<string, unknown>[] = [];
  const port: NativeHttpPort = {
    httpRequest: vi.fn(async (value): Promise<unknown> => {
      calls.push(value);

      return {
        httpVersion: 1,
        cycleId: value.cycleId,
        requestId: value.requestId,
        result: {
          status: 200,
          statusText: '',
          headers: [
            ['Content-Type', 'application/octet-stream'],
            ['Set-Cookie', 'secret'],
          ],
          bodyBase64: btoa('\x00\xff'),
          url: origin + '/api/groups',
        },
      };
    }),
    httpCancel: vi.fn(async (): Promise<void> => {}),
  };
  const controller = new AbortController();
  const transport = new NativeHttpTransport(port);

  transport.activate(crypto.randomUUID(), origin, controller.signal);

  return { transport, port, controller, calls };
}
afterEach((): void => {
  vi.useRealTimers();
});
describe('native Fetch adapter', (): void => {
  it('normalizes input, preserves binary Response/clone metadata and strips cookies/tokens', async (): Promise<void> => {
    const { transport, calls } = fixture();
    const result = await transport.request('/api/groups', {
      method: 'POST',
      headers: { Authorization: 'Bearer web-secret' },
      body: new Uint8Array([0, 255]),
    });

    expect(result).toBeInstanceOf(Response);
    expect(result.url).toBe(origin + '/api/groups');
    expect(result.type).toBe('basic');
    expect(result.redirected).toBe(false);
    expect(result.headers.has('Set-Cookie')).toBe(false);
    const copy = result.clone();

    expect(copy.url).toBe(result.url);
    expect(copy.type).toBe('basic');
    expect([...new Uint8Array(await result.arrayBuffer())]).toEqual([0, 255]);
    expect([...new Uint8Array(await copy.arrayBuffer())]).toEqual([0, 255]);
    expect(JSON.stringify(calls)).not.toContain('web-secret');
    expect(calls[0].request).toMatchObject({
      url: origin + '/api/groups',
      method: 'POST',
      bodyBase64: 'AP8=',
    });
  });
  it('honors Request/init precedence and FormData serialization', async (): Promise<void> => {
    const { transport, calls } = fixture();
    const previous = new AbortController();

    previous.abort();
    const input = new Request(origin + '/api/groups', {
      method: 'PUT',
      body: 'old',
      redirect: 'error',
      signal: previous.signal,
    });
    const form = new FormData();

    form.set('name', 'fixture');
    await transport.request(input, {
      method: 'POST',
      headers: {},
      body: form,
      signal: new AbortController().signal,
    });
    const request = calls[0].request as { headers: string[][]; bodyBase64: string };

    expect(
      request.headers.some(
        ([name, value]): boolean =>
          name === 'content-type' && value.startsWith('multipart/form-data; boundary='),
      ),
    ).toBe(true);
    expect(atob(request.bodyBase64)).toContain('fixture');
  });
  it('rejects unsupported/unsafe inputs before sending', async (): Promise<void> => {
    const { transport, calls } = fixture();

    for (const init of [
      { credentials: 'include' },
      { cache: 'force-cache' },
      { mode: 'no-cors' },
      { redirect: 'follow' },
      { redirect: 'manual' },
      { keepalive: true },
      { integrity: 'sha256-value' },
      { dispatcher: {} },
      { body: new ReadableStream(), method: 'POST' },
    ]) {
      await expect(transport.request('/api/groups', init as RequestInit)).rejects.toMatchObject({
        cause: { code: 'UNSUPPORTED' },
      });
    }

    for (const url of [
      'https://foreign.test/api',
      'https://user:secret@gchat.test/api',
      '/api#secret',
    ]) {
      await expect(transport.request(url)).rejects.toMatchObject({
        cause: { code: 'INVALID_ARGUMENT' },
      });
    }

    await expect(
      transport.request('/api', { headers: { Cookie: 'secret' } }),
    ).rejects.toMatchObject({ cause: { code: 'INVALID_ARGUMENT' } });
    expect(calls).toHaveLength(0);
  });
  it('cancels the same native request and ignores a late successful reply', async (): Promise<void> => {
    const { transport, port, controller } = fixture();
    let complete!: (value: unknown) => void;

    vi.mocked(port.httpRequest).mockImplementation(
      (value): Promise<unknown> =>
        new Promise((resolve): void => {
          complete = resolve;
          void value;
        }),
    );
    const pending = transport.request('/api/groups');

    await vi.waitFor((): void => {
      expect(port.httpRequest).toHaveBeenCalledOnce();
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(port.httpCancel).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: vi.mocked(port.httpRequest).mock.calls[0][0].requestId,
      }),
    );
    complete({});
  });
  it('does not submit a preaborted request or use WebView fallback', async (): Promise<void> => {
    const { transport, calls } = fixture();

    await expect(transport.request('/api', { signal: AbortSignal.abort() })).rejects.toMatchObject({
      name: 'AbortError',
    });
    transport.clear();
    await expect(transport.request('/api')).rejects.toMatchObject({
      cause: { code: 'BRIDGE_UNAVAILABLE' },
    });
    expect(calls).toHaveLength(0);
  });
  it('rejects oversized request/response and mismatched bridge correlation', async (): Promise<void> => {
    const { transport, port, calls } = fixture();

    await expect(
      transport.request('/api', { method: 'POST', body: new Uint8Array(8 * 1024 * 1024 + 1) }),
    ).rejects.toMatchObject({ cause: { code: 'UNSUPPORTED' } });
    expect(calls).toHaveLength(0);
    vi.mocked(port.httpRequest).mockResolvedValue({
      httpVersion: 1,
      cycleId: crypto.randomUUID(),
      requestId: crypto.randomUUID(),
      error: { kind: 'network', code: 'NETWORK_ERROR' },
    });
    await expect(transport.request('/api')).rejects.toMatchObject({
      cause: { code: 'BRIDGE_UNAVAILABLE' },
    });
    vi.mocked(port.httpRequest).mockImplementation(async (value): Promise<unknown> => ({
      ...value,
      request: undefined,
    }));
    await expect(transport.request('/api')).rejects.toMatchObject({
      cause: { code: 'BRIDGE_UNAVAILABLE' },
    });
  });
  it('preserves HTTP error statuses, bodyless responses and safe transport errors', async (): Promise<void> => {
    const { transport, port } = fixture();

    for (const status of [204, 205, 304, 422, 500]) {
      vi.mocked(port.httpRequest).mockImplementation(async (value): Promise<unknown> => ({
        httpVersion: 1,
        cycleId: value.cycleId,
        requestId: value.requestId,
        result: { status, statusText: '', headers: [], bodyBase64: '', url: origin + '/api' },
      }));
      const result = await transport.request('/api');

      expect(result.status).toBe(status);

      if ([204, 205, 304].includes(status)) {
        expect(result.body).toBeNull();
      }
    }

    for (const kind of ['network', 'timeout', 'aborted']) {
      vi.mocked(port.httpRequest).mockImplementation(async (value): Promise<unknown> => ({
        httpVersion: 1,
        cycleId: value.cycleId,
        requestId: value.requestId,
        error: { kind, code: kind === 'timeout' ? 'TIMEOUT' : 'NETWORK_ERROR' },
      }));
      await expect(transport.request('/api')).rejects.toMatchObject(
        kind === 'aborted'
          ? { name: 'AbortError' }
          : { cause: { code: kind === 'timeout' ? 'TIMEOUT' : 'NETWORK_ERROR' } },
      );
    }
  });
  it('sanitizes malformed native replies and exceptions during input normalization', async (): Promise<void> => {
    const { transport, port } = fixture();
    const input = new URL(origin);

    input.toString = (): never => {
      throw new TypeError('private value', { cause: { code: 'private value' } });
    };
    await expect(transport.request(input)).rejects.toMatchObject({
      cause: { code: 'INVALID_ARGUMENT' },
    });
    vi.mocked(port.httpRequest).mockImplementation(async (value): Promise<unknown> => ({
      httpVersion: 1,
      cycleId: value.cycleId,
      requestId: value.requestId,
      result: {
        status: 200,
        statusText: '',
        headers: [],
        bodyBase64: '%%%private',
        url: origin + '/api',
      },
    }));
    await expect(transport.request('/api')).rejects.toMatchObject({
      cause: { code: 'BRIDGE_UNAVAILABLE' },
    });
  });
  it('times out once, cancels native and preserves an active request during identical context updates', async (): Promise<void> => {
    vi.useFakeTimers();
    const { transport, port, controller } = fixture();
    const cycle = crypto.randomUUID();

    transport.activate(cycle, origin, controller.signal);
    vi.mocked(port.httpRequest).mockImplementation(
      (): Promise<unknown> => new Promise((): void => {}),
    );
    const pending = transport.request('/api');
    const assertion = expect(pending).rejects.toMatchObject({ cause: { code: 'TIMEOUT' } });

    await vi.advanceTimersByTimeAsync(1);
    transport.activate(cycle, origin, controller.signal);
    await vi.advanceTimersByTimeAsync(30000);
    await assertion;
    expect(port.httpRequest).toHaveBeenCalledOnce();
    expect(port.httpCancel).toHaveBeenCalledOnce();
  });
});
