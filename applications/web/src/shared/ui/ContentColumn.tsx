import './tokens.css';
import './ContentColumn.css';

import type { ComponentPropsWithoutRef, JSX } from 'react';

export function ContentColumn({
  className = '',
  ...props
}: ComponentPropsWithoutRef<'div'>): JSX.Element {
  return <div {...props} className={'ui-content-column ' + className} />;
}
