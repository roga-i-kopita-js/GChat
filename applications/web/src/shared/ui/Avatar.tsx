import './tokens.css';

import type { JSX } from 'react';

export function Avatar({
  name,
  large = false,
  seed = name,
}: {
  name: string;
  large?: boolean;
  seed?: string;
}): JSX.Element {
  const paletteSize = 5;
  const index = [...seed].reduce((sum, char): number => sum + char.charCodeAt(0), 0) % paletteSize;

  return (
    <span
      className={'avatar' + (large ? ' large' : '')}
      style={{ background: `var(--ui-avatar-${index + 1})` }}
      aria-hidden="true"
    >
      {name
        .trim()
        .split(/\s+/)
        .slice(0, 2)
        .map((word): string => word[0] ?? '')
        .join('')
        .toUpperCase()}
    </span>
  );
}
