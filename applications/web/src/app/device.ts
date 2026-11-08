import type { BackendApi } from '@gchat/backend-api';

import type { SessionState } from '../shared/device';
import type { HttpSession } from '../shared/device/router-context';

export type ApplicationDevice = HttpSession<BackendApi>;

export type ApplicationSessionState = SessionState;
