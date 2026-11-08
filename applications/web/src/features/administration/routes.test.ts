import { BackendApi } from '@gchat/backend-api';
import type { ActionFunctionArgs } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import type { ApplicationDevice, ApplicationSessionState } from '../../app/device';
import {
  adminResultsContext,
  createApplicationContext,
  userContext,
} from '../../app/router-context';
import { readFields, readQuery } from '../../shared/validation/request';
import { loginFormSchema } from '../auth/request-schemas';
import { contactsQuerySchema } from '../calls/request-schemas';
import { adminAction, adminUserLoader, adminUsersLoader } from './routes';

const userId = '00000000-0000-4000-8000-000000000031';
const password = '  example password  ';
const savedUser = {
  id: userId,
  login: 'anna',
  display_name: 'Анна',
  role: 'user',
  status: 'active',
  disabled_at: null,
  groups: [],
  created_at: '',
  updated_at: '',
};

function form(values: Record<string, string>): FormData {
  const result = new FormData();

  for (const [key, value] of Object.entries(values)) {
    result.set(key, value);
  }

  return result;
}
function fixture(): {
  args: (request: Request) => ActionFunctionArgs;
  fetch: ReturnType<typeof vi.fn<typeof globalThis.fetch>>;
} {
  const fetch = vi.fn<typeof globalThis.fetch>(
    async (): Promise<Response> =>
      new Response(JSON.stringify({ user: savedUser, users: [], total: 0 }), {
        headers: { 'Content-Type': 'application/json' },
      }),
  );
  const http = new BackendApi({ baseUrl: 'https://fixture.test/api', fetch });
  const state: ApplicationSessionState = {
    revision: 1,
    status: 'authenticated',
    generation: 1,
    error: null,
    identity: { id: 'admin', login: 'admin', displayName: 'Администратор', role: 'admin' },
  };
  const device: ApplicationDevice = {
    http,
    session: {
      getState: async (): Promise<ApplicationSessionState> => state,
      on: (): (() => void) => (): void => {},
      run: <T>(
        operation: (api: BackendApi, signal: AbortSignal) => Promise<T>,
        options: { signal?: AbortSignal } = {},
      ): Promise<T> => operation(http, options.signal ?? new AbortController().signal),
      login: async (): Promise<void> => {},
      logout: async (): Promise<void> => {},
    },
  };
  const context = createApplicationContext(device)();

  context.set(userContext, { sub: 'admin', sid: '1', role: 'admin' });

  return {
    fetch,
    args: (request): ActionFunctionArgs => ({
      request,
      url: new URL(request.url),
      pattern: '/admin/users/:userId?',
      params: {},
      context,
    }),
  };
}
function request(body: FormData, method = 'POST'): Request {
  return new Request('https://fixture.test/admin/users', { method, body });
}

describe('route request validation', (): void => {
  it.each<Record<string, string>>([
    { operation: 'create', display_name: ' ', group_name: 'team', password },
    { operation: 'create', display_name: 'Анна', group_name: ' ', password },
    { operation: 'create', display_name: 'Анна', group_name: 'team', login: 'bad login', password },
    { operation: 'password', user_id: userId, password: 'short' },
    { operation: 'password', user_id: userId, password: 'x'.repeat(129) },
    { operation: 'disable', user_id: 'invalid' },
    { operation: 'enable', user_id: userId, password },
    { operation: 'unknown', user_id: userId },
  ])('rejects invalid operations before HTTP: %j', async (values): Promise<void> => {
    const { args, fetch } = fixture();
    const result = await adminAction(args(request(form(values))));

    expect(result.outcome).toBe('invalid');
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(password);
  });
  it('rejects duplicate fields, file values, malformed bodies and unsupported methods without HTTP', async (): Promise<void> => {
    const { args, fetch } = fixture();
    const duplicate = form({ operation: 'disable', user_id: userId });

    duplicate.append('user_id', userId);
    const file = form({ operation: 'password', user_id: userId });

    file.set('password', new Blob(['a secret password']), 'password.txt');

    for (const input of [
      request(duplicate),
      request(file),
      request(form({ operation: 'disable', user_id: userId }), 'PUT'),
      new Request('https://fixture.test/admin/users', { method: 'POST', body: 'not a form' }),
    ]) {
      expect((await adminAction(args(input))).outcome).toBe('invalid');
    }

    expect(fetch).not.toHaveBeenCalled();
  });
  it('sends the normalized create DTO, preserves password spaces and publishes credentials only after success', async (): Promise<void> => {
    const { args, fetch } = fixture();
    const input = args(
      request(
        form({
          operation: 'create',
          display_name: ' Анна ',
          group_name: ' team ',
          login: ' ANNA ',
          password,
        }),
      ),
    );
    const published = vi.fn();

    input.context.get(adminResultsContext).subscribe(published);
    expect(await adminAction(input)).toEqual({ outcome: 'saved', user: savedUser });
    expect(fetch).toHaveBeenCalledOnce();
    expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toEqual({
      display_name: 'Анна',
      group_name: 'team',
      login: 'anna',
      password,
    });
    expect(published).toHaveBeenCalledWith({ login: 'anna', password, self: false }, '1');
  });
  it.each(['password', 'disable', 'enable'])(
    'sends valid %s operations to their SDK endpoint',
    async (operation): Promise<void> => {
      const { args, fetch } = fixture();
      const body = form({ operation, user_id: userId });

      if (operation === 'password') {
        body.set('password', password);
      }

      expect((await adminAction(args(request(body)))).outcome).toBe('saved');
      expect(fetch).toHaveBeenCalledOnce();
      expect(String(fetch.mock.calls[0]![0])).toContain(`/admin/users/${userId}/${operation}`);
      expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toEqual(
        operation === 'password' ? { password } : {},
      );
    },
  );
  it('rejects invalid user params without HTTP and normalizes list query through its schema', async (): Promise<void> => {
    const { args, fetch } = fixture();
    const invalid = args(new Request('https://fixture.test/admin/users/invalid'));

    invalid.params = { userId: 'invalid' };
    expect((await adminUserLoader(invalid)).data).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    const loaded = await adminUsersLoader(
      args(new Request('https://fixture.test/admin/users?q=+anna+&status=active&offset=25')),
    );

    expect(loaded.filters).toEqual({ q: 'anna', status: 'active', offset: 25 });
    const url = new URL(String(fetch.mock.calls[0]![0]));

    expect(Object.fromEntries(url.searchParams)).toEqual({
      q: 'anna',
      status: 'active',
      offset: '25',
      limit: '25',
    });
  });
  it('uses safe defaults for invalid or duplicate optional filters', async (): Promise<void> => {
    const { args, fetch } = fixture();
    const loaded = await adminUsersLoader(
      args(
        new Request('https://fixture.test/admin/users?q=a&q=b&status=no&offset=9007199254740992'),
      ),
    );

    expect(loaded.filters).toEqual({ q: '', status: 'all', offset: 0 });
    expect(fetch).toHaveBeenCalledOnce();

    for (const query of ['group=invalid', `group=${userId}&group=all`]) {
      expect(
        readQuery(contactsQuerySchema, new Request('https://fixture.test/calls?' + query)).group,
      ).toBeUndefined();
    }
  });
  it('validates login with the same duplicate-safe form reader and preserves password spaces', (): void => {
    const input = form({ login: ' ANNA ', password });

    expect(readFields(loginFormSchema, input)).toEqual({ login: 'anna', password });
    input.append('password', password);
    expect((): unknown => readFields(loginFormSchema, input)).toThrow();
  });
  it('propagates cancellation instead of presenting it as invalid form data', async (): Promise<void> => {
    const { args, fetch } = fixture();
    const controller = new AbortController();

    controller.abort();
    const input = new Request('https://fixture.test/admin/users', {
      method: 'POST',
      body: form({ operation: 'disable', user_id: userId }),
      signal: controller.signal,
    });

    await expect(adminAction(args(input))).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetch).not.toHaveBeenCalled();
  });
});
