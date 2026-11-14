import './tokens.css';
import './PageHeader.css';

import { Snowflake } from 'lucide-react';
import type { ComponentPropsWithoutRef, JSX } from 'react';

export function PageHeader({
  className = '',
  variant = 'default',
  children,
  ...props
}: ComponentPropsWithoutRef<'header'> & { variant?: 'default' | 'section' }): JSX.Element {
  return (
    <header {...props} className={`ui-page-header ui-page-header-${variant} ${className}`}>
      {children}
      {variant === 'section' && <Snowflake className="ui-page-header-motif" aria-hidden="true" />}
    </header>
  );
}
