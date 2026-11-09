import './tokens.css';
import './Button.css';

import type { ComponentPropsWithRef, JSX } from 'react';

export type ButtonProps = ComponentPropsWithRef<'button'> & {
  variant?: 'primary' | 'secondary' | 'ghost';
  tone?: 'default' | 'danger';
  size?: 'default' | 'small' | 'icon';
};

export function Button({
  type = 'button',
  variant = 'primary',
  tone = 'default',
  size = 'default',
  className = '',
  ...props
}: ButtonProps): JSX.Element {
  return (
    <button
      {...props}
      type={type}
      className={
        'ui-button ui-button-' +
        variant +
        ' ui-button-tone-' +
        tone +
        ' ui-button-size-' +
        size +
        ' ' +
        className
      }
    />
  );
}
