import './tokens.css';
import './Skeleton.css';

import type { ComponentPropsWithoutRef, CSSProperties, JSX } from 'react';

export type SkeletonProps = ComponentPropsWithoutRef<'div'> & {
  as?: 'div' | 'span';
  loading?: boolean;
  variant?: 'text' | 'rectangular' | 'circular';
  animated?: boolean;
  width?: string;
  height?: string;
};

type SkeletonStyle = CSSProperties & {
  '--ui-skeleton-width'?: string;
  '--ui-skeleton-height'?: string;
};

export function Skeleton({
  as: Element = 'div',
  loading = true,
  variant = 'text',
  animated = true,
  width,
  height,
  children,
  className = '',
  style,
  inert,
  'aria-hidden': ariaHidden,
  ...props
}: SkeletonProps): JSX.Element | null {
  const withContent = children !== undefined && children !== null && children !== false;

  if (!loading && !withContent) {
    return null;
  }

  const dimensions: SkeletonStyle = {
    ...style,
    ...(width ? { '--ui-skeleton-width': width } : {}),
    ...(height ? { '--ui-skeleton-height': height } : {}),
  };

  return (
    <Element
      {...props}
      className={
        'ui-skeleton ui-skeleton-' +
        variant +
        (withContent ? ' ui-skeleton-with-content' : '') +
        (loading ? ' ui-skeleton-loading' : '') +
        (animated ? '' : ' ui-skeleton-static') +
        (Element === 'span' ? ' ui-skeleton-inline' : '') +
        ' ' +
        className
      }
      style={dimensions}
      inert={loading || inert || undefined}
      aria-hidden={loading ? true : ariaHidden}
    >
      {withContent && <Element className="ui-skeleton-content">{children}</Element>}
    </Element>
  );
}
