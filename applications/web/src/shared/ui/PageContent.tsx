import './tokens.css';
import './PageContent.css';

import type { ComponentPropsWithoutRef, JSX } from 'react';

type PageContentProps = ComponentPropsWithoutRef<'main'> & { contained?: boolean };

export function PageContent({
  contained = false,
  className = '',
  ...props
}: PageContentProps): JSX.Element {
  return (
    <main
      {...props}
      className={
        'ui-page-content' + (contained ? ' ui-page-content-contained' : '') + ' ' + className
      }
    />
  );
}
