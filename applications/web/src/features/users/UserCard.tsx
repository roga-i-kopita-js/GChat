import './UserCard.css';

import type { JSX, ReactNode } from 'react';

import { Avatar } from '../../shared/ui';

export function UserCard({
  userId,
  displayName,
  subtitle,
  multiline = false,
}: {
  userId: string;
  displayName: string;
  subtitle?: ReactNode;
  multiline?: boolean;
}): JSX.Element {
  return (
    <span className={'user-card' + (multiline ? ' user-card-multiline' : '')}>
      <Avatar name={displayName} seed={userId} />
      <span className="user-card-copy">
        <strong className="user-card-name">{displayName}</strong>
        {subtitle && <span className="user-card-subtitle">{subtitle}</span>}
      </span>
    </span>
  );
}
