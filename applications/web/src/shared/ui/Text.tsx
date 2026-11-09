import './tokens.css';
import './Text.css';

import type { ComponentPropsWithoutRef, JSX } from 'react';

export type TextProps = ComponentPropsWithoutRef<'span'> & {
  as?: 'span' | 'p' | 'small' | 'h1' | 'h2' | 'h3';
  variant?: 'body' | 'label' | 'caption' | 'heading' | 'title';
  tone?: 'default' | 'muted' | 'danger' | 'success';
  weight?: 'regular' | 'medium' | 'semibold';
};

export function Text({
  as: Element = 'span',
  variant = 'body',
  tone = 'default',
  weight,
  className = '',
  ...props
}: TextProps): JSX.Element {
  return (
    <Element
      {...props}
      className={
        'ui-text ui-text-' +
        variant +
        ' ui-text-tone-' +
        tone +
        (weight ? ' ui-text-weight-' + weight : '') +
        ' ' +
        className
      }
    />
  );
}
