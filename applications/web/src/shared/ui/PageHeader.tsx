import './tokens.css';
import './PageHeader.css';

import type { ComponentPropsWithoutRef, JSX } from 'react';

export function PageHeader({
  className = '',
  ...props
}: ComponentPropsWithoutRef<'header'>): JSX.Element {
  return <header {...props} className={'ui-page-header ' + className} />;
}
