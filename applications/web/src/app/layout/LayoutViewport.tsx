import type { JSX, ReactNode } from 'react';
import { useLayoutEffect, useRef } from 'react';
import { useLocation } from 'react-router';

import { useLayout } from './LayoutProvider';

export function LayoutViewport({ children }: { children: ReactNode }): JSX.Element {
  const { contained } = useLayout();
  const { pathname } = useLocation();
  const viewport = useRef<HTMLDivElement>(null);

  useLayoutEffect((): void => {
    viewport.current?.scrollTo(0, 0);
  }, [pathname]);

  return (
    <div ref={viewport} className={'app-viewport' + (contained ? ' app-viewport-contained' : '')}>
      {children}
    </div>
  );
}
