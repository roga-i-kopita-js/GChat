import './PageSurface.css';

import type { ComponentPropsWithoutRef, JSX } from 'react';

import { Card } from './Card';

export function PageSurface({
  className = '',
  ...props
}: ComponentPropsWithoutRef<'div'>): JSX.Element {
  return (
    <Card
      {...props}
      padding="none"
      bordered={false}
      clip
      className={'ui-page-surface ' + className}
    />
  );
}
