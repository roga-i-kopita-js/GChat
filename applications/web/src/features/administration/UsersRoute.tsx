import type { JSX } from 'react';
import { useContext } from 'react';

import { CredentialsContext } from '../../app/App';
import { useAuth } from '../auth/AuthProvider';
import { useCalls } from '../calls/CallsProvider';
import { UsersPage } from './UsersPage';

export function AdminUsersRoute(): JSX.Element | null {
  const { user } = useAuth();
  const { incoming } = useCalls();
  const credentials = useContext(CredentialsContext);

  if (!user || !credentials) {
    return null;
  }

  return (
    <UsersPage
      key={user.sid}
      userId={user.sub}
      sessionId={user.sid}
      showDetails={!credentials.value && !incoming}
      onCredentials={(value): void => {
        credentials.show(value, user.sid);
      }}
    />
  );
}
