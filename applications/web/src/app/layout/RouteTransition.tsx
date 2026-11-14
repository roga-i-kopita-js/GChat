import type { JSX, ReactNode } from 'react';
import { useEffect, useState, ViewTransition } from 'react';
import { useLocation, useNavigationType } from 'react-router';

import { useLayout } from './LayoutProvider';
import { layoutNavigation } from './sections';

export function RouteTransition({ children }: { children: ReactNode }): JSX.Element {
  const { key, pathname } = useLocation();
  const navigationType = useNavigationType();
  const { section } = useLayout();
  const [committedRoute, setCommittedRoute] = useState({
    key,
    section,
    pathname,
    entries: [key],
    position: 0,
  });
  const navigating = committedRoute.pathname !== pathname;
  const previousIndex = layoutNavigation.findIndex(
    (item) => item.section === committedRoute.section,
  );
  const nextIndex = layoutNavigation.findIndex((item) => item.section === section);
  const parent = pathname.replace(/\/$/, '') + '/';
  const previousParent = committedRoute.pathname.replace(/\/$/, '') + '/';
  const returningToParent = committedRoute.pathname.startsWith(parent);
  const openingChild = pathname.startsWith(previousParent);
  const historyPosition = committedRoute.entries.indexOf(key);
  const historyBack = navigationType === 'POP' && historyPosition < committedRoute.position;
  const directionKnown =
    section !== committedRoute.section ||
    returningToParent ||
    openingChild ||
    navigationType !== 'POP' ||
    historyPosition !== -1;
  const backward =
    section !== committedRoute.section
      ? nextIndex < previousIndex
      : returningToParent || (!openingChild && historyBack);
  const animation = backward ? 'route-page-backward' : 'route-page-forward';

  // React runs passive effects after the transition; reset the prop for later fetcher updates.
  useEffect((): void => {
    setCommittedRoute((previous) => {
      let entries = previous.entries;
      let position = entries.indexOf(key);

      if (navigationType === 'REPLACE') {
        position = previous.position;
        entries = entries.map((entry, index) => (index === position ? key : entry));
      } else if (navigationType === 'POP' && position === -1) {
        entries = [key];
        position = 0;
      } else if (position === -1) {
        entries = [...entries.slice(0, previous.position + 1), key];
        position = entries.length - 1;
      }

      return { key, section, pathname, entries, position };
    });
  }, [key, section, pathname, navigationType]);

  return (
    <ViewTransition default="none" update={navigating && directionKnown ? animation : 'none'}>
      {children}
    </ViewTransition>
  );
}
