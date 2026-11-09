import './tokens.css';
import './LoadingBar.css';

import type { ComponentPropsWithoutRef, JSX } from 'react';
import { useEffect, useRef } from 'react';

export type LoadingBarProps = ComponentPropsWithoutRef<'div'> & {
  complete?: boolean;
  onComplete?(): void;
};

export function LoadingBar({
  className = '',
  complete = false,
  onComplete,
  onAnimationEnd,
  'aria-label': label = 'Загрузка',
  ...props
}: LoadingBarProps): JSX.Element {
  const element = useRef<HTMLDivElement>(null);

  useEffect((): (() => void) | undefined => {
    const node = element.current;

    if (!complete || !onComplete || !node) {
      return;
    }

    let frame: number | undefined;
    const finishWithoutAnimation = (): void => {
      if (
        getComputedStyle(node)
          .animationName.split(',')
          .some((name): boolean => name.trim() === 'ui-loading-bar-dismiss')
      ) {
        return;
      }

      if (frame !== undefined) {
        cancelAnimationFrame(frame);
      }

      // Keep the full-width static state for a paint when motion is disabled.
      frame = requestAnimationFrame((): void => {
        frame = requestAnimationFrame(onComplete);
      });
    };

    node.addEventListener('animationcancel', finishWithoutAnimation);
    finishWithoutAnimation();

    return (): void => {
      node.removeEventListener('animationcancel', finishWithoutAnimation);

      if (frame !== undefined) {
        cancelAnimationFrame(frame);
      }
    };
  }, [complete, onComplete]);

  return (
    <div
      {...props}
      ref={element}
      role="progressbar"
      aria-label={label}
      aria-valuenow={complete ? 100 : undefined}
      className={'ui-loading-bar' + (complete ? ' ui-loading-bar-complete' : '') + ' ' + className}
      onAnimationEnd={(event): void => {
        onAnimationEnd?.(event);

        if (complete && event.animationName === 'ui-loading-bar-dismiss') {
          onComplete?.();
        }
      }}
    />
  );
}
