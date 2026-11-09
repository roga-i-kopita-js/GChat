import './UserCard.css';

import type { JSX } from 'react';

import { Avatar } from '../../shared/ui';

export function UserCard({
  userId,
  displayName,
  subtitle,
}: {
  userId: string;
  displayName: string;
  subtitle?: string;
}): JSX.Element {
  return (
    <span className="user-card">
      <Avatar name={displayName} seed={userId} />
      <span className="user-card-copy">
        <strong className="user-card-name">{displayName}</strong>
        {subtitle && <span className="user-card-subtitle">{subtitle}</span>}
      </span>
    </span>
  );
}
