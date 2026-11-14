import './tokens.css';
import './Avatar.css';

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
  const tones = ['sky', 'ice', 'mist', 'steel'];
  const index = [...seed].reduce((sum, char): number => sum + char.charCodeAt(0), 0) % tones.length;

  return (
    <span
      className={'avatar' + (large ? ' large' : '')}
      data-tone={tones[index]}
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
