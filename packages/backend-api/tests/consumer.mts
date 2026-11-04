import { type AdminUserDto, type ApiResult, BackendApi } from '@gchat/backend-api';

const api = new BackendApi({
  baseUrl: '/api',
  getAccessToken: async (): Promise<string> => 'token',
});

api.adminListUsers();
api.adminListUsers({ query: { q: 'ivan' } });
api.healthcheckHealth({ signal: new AbortController().signal });
const logout: Promise<ApiResult<undefined>> = api.authLogout({ body: { refresh_token: 'token' } });

void logout;
const nullable: AdminUserDto['disabled_at'] = null;

void nullable;
// @ts-expect-error body is required
api.authLogin();
// @ts-expect-error path is required
api.adminGetUser({});
// @ts-expect-error unknown query fields
api.adminListUsers({ query: { search: 'invalid' } });
// @ts-expect-error no query section for this operation
api.groupsList({ query: {} });
// @ts-expect-error URL is controlled by the operation
api.healthcheckHealth({ url: '/different' });
// @ts-expect-error required baseUrl
new BackendApi({});
