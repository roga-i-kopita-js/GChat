import './tokens.css';
import './Card.css';

import type { ComponentPropsWithRef, JSX } from 'react';

export type CardProps = ComponentPropsWithRef<'div'> & {
  padding?: 'none' | 'small' | 'medium';
  bordered?: boolean;
  clip?: boolean;
};

export function Card({
  padding = 'medium',
  bordered = true,
  clip = false,
  className = '',
  ...props
}: CardProps): JSX.Element {
  return (
    <div
      {...props}
      className={
        'ui-card ui-card-padding-' +
        padding +
        (bordered ? '' : ' ui-card-borderless') +
        (clip ? ' ui-card-clip' : '') +
        ' ' +
        className
      }
    />
  );
}
