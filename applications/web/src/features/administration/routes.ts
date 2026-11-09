import type { BackendApi } from '@gchat/backend-api';
import {
  type AdminGroupsResponseDto,
  type AdminUserResponseDto,
  type AdminUsersResponseDto,
  ApiError,
} from '@gchat/backend-api';
import type { ActionFunctionArgs, LoaderFunctionArgs } from 'react-router';

import { adminResultsContext, applicationDevice, userContext } from '../../app/router-context';
import { DeviceError } from '../../shared/device';
import { readForm, readQuery } from '../../shared/validation/request';
import { mutationError } from './policy';
import {
  adminGroupsQuerySchema,
  type AdminOperation,
  adminOperationSchema,
  adminUserParamsSchema,
  type AdminUsersFilters,
  adminUsersQuerySchema,
  adminValidationMessage,
} from './request-schemas';

export interface AdminData<T> {
  sid: string | null;
  data: T | null;
  error: string | null;
}

export interface AdminUsersData extends AdminData<AdminUsersResponseDto> {
  filters: AdminUsersFilters;
}

export type AdminResult =
  | { outcome: 'saved'; user: AdminUserResponseDto['user'] }
  | { outcome: 'invalid' | 'failed' | 'unknown'; error: string };

function readError(cause: unknown): string {
  if (cause instanceof ApiError && cause.status === 403) {
    return 'Доступ запрещён. Требуются права администратора.';
  }

  if (cause instanceof ApiError && cause.status === 404) {
    return 'Аккаунт не найден.';
  }

  return 'Не удалось загрузить данные. Проверьте соединение и повторите запрос.';
}

export async function adminUsersLoader({
  request: input,
  context,
}: LoaderFunctionArgs): Promise<AdminUsersData> {
  const device = applicationDevice(context);
  const user = context.get(userContext);

  const filters = readQuery(adminUsersQuerySchema, input);

  if (user.role !== 'admin') {
    return {
      sid: null,
      data: null,
      error: 'Доступ запрещён. Требуются права администратора.',
      filters,
    };
  }

  try {
    const { data: runResultData } = await device.session.run(
      (api, signal): ReturnType<BackendApi['adminListUsers']> =>
        api.adminListUsers({
          query: { ...filters, limit: 25 },
          signal,
        }),
      { signal: input.signal },
    );

    return {
      sid: user.sid,
      filters,
      data: runResultData,
      error: null,
    };
  } catch (error) {
    input.signal.throwIfAborted();

    return { sid: user.sid, data: null, error: readError(error), filters };
  }
}

export async function adminUserLoader({
  request: input,
  context,
  params,
}: LoaderFunctionArgs): Promise<AdminData<AdminUserResponseDto>> {
  const device = applicationDevice(context);
  const user = context.get(userContext);

  if (user.role !== 'admin') {
    return { sid: null, data: null, error: 'Доступ запрещён. Требуются права администратора.' };
  }

  const parsed = adminUserParamsSchema.safeParse(params);

  if (!parsed.success) {
    return { sid: user.sid, data: null, error: 'Аккаунт не найден.' };
  }

  const id = parsed.data.userId;

  try {
    const { data: runResultData2 } = await device.session.run(
      (api, signal): ReturnType<BackendApi['adminGetUser']> =>
        api.adminGetUser({ path: { user_id: id }, signal }),
      { signal: input.signal },
    );

    return {
      sid: user.sid,
      data: runResultData2,
      error: null,
    };
  } catch (error) {
    input.signal.throwIfAborted();

    return { sid: user.sid, data: null, error: readError(error) };
  }
}

export async function adminGroupsLoader({
  request: input,
  context,
}: LoaderFunctionArgs): Promise<AdminData<AdminGroupsResponseDto>> {
  const device = applicationDevice(context);
  const user = context.get(userContext);

  if (user.role !== 'admin') {
    return { sid: null, data: null, error: 'Доступ запрещён' };
  }

  const query = readQuery(adminGroupsQuerySchema, input);

  try {
    const { data: runResultData3 } = await device.session.run(
      (api, signal): ReturnType<BackendApi['adminListGroups']> =>
        api.adminListGroups({
          query: {
            ...query,
            limit: 20,
            offset: 0,
          },
          signal,
        }),
      { signal: input.signal },
    );

    return {
      sid: user.sid,
      data: runResultData3,
      error: null,
    };
  } catch (error) {
    input.signal.throwIfAborted();

    return { sid: user.sid, data: null, error: readError(error) };
  }
}

export async function adminAction({
  request: input,
  context,
}: ActionFunctionArgs): Promise<AdminResult> {
  const device = applicationDevice(context);
  const results = context.get(adminResultsContext);
  const actor = context.get(userContext);

  if (actor.role !== 'admin') {
    return { outcome: 'failed', error: 'Недостаточно прав для этой операции.' };
  }

  let form: AdminOperation;

  try {
    form = await readForm(adminOperationSchema, input);
  } catch {
    input.signal.throwIfAborted();

    return { outcome: 'invalid', error: adminValidationMessage };
  }

  try {
    const { data: runResultData4 } = await device.session.run(
      async (api, signal): ReturnType<BackendApi['adminCreateUser']> => {
        const {
          status: currentStatus,
          generation: currentGeneration,
          identity: currentIdentity,
        } = await device.session.getState({ signal });

        if (
          currentStatus !== 'authenticated' ||
          String(currentGeneration) !== actor.sid ||
          currentIdentity?.id !== actor.sub
        ) {
          throw new DeviceError('CANCELLED');
        }

        signal.throwIfAborted();

        if (form.operation === 'create') {
          const { operation: _operation, ...body } = form;

          return api.adminCreateUser({
            body,
            signal,
          });
        }

        if (form.operation === 'password') {
          return api.adminChangeUserPassword({
            path: { user_id: form.user_id },
            body: { password: form.password },
            signal,
          });
        }

        if (form.operation === 'disable') {
          return api.adminDisableUser({ path: { user_id: form.user_id }, body: {}, signal });
        }

        if (form.operation === 'enable') {
          return api.adminEnableUser({ path: { user_id: form.user_id }, body: {}, signal });
        }

        throw new TypeError('Invalid operation');
      },
      { signal: input.signal },
    );
    const saved = runResultData4;

    if (form.operation === 'create' || form.operation === 'password') {
      results.publish(
        {
          login: saved.user.login,
          password: form.password,
          self: form.operation === 'password' && saved.user.id === actor.sub,
        },
        actor.sid,
      );
    }

    return { outcome: 'saved', user: saved.user };
  } catch (error) {
    const confirmed =
      error instanceof ApiError && error.status >= 400 && error.status < 500 && !!error.code;

    return { outcome: confirmed ? 'failed' : 'unknown', error: mutationError(error) };
  }
}
