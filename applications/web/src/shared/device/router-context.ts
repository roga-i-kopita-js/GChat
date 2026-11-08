import { createContext } from 'react-router';

import type { SessionService } from './api';

export interface HttpSession<THttp = unknown> {
  readonly http: THttp;
  readonly session: SessionService<THttp>;
}

export const deviceContext = createContext<HttpSession>();
