import type { JSX, ReactNode } from 'react';
import { Component, Suspense } from 'react';

interface Props {
  children: ReactNode;
  pending: ReactNode;
  failed: ReactNode;
}

/** A failed panel import must not replace the application's runtime owners. */
export class LazyPanel extends Component<Props, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render(): JSX.Element {
    return this.state.failed ? (
      <>{this.props.failed}</>
    ) : (
      <Suspense fallback={this.props.pending}>{this.props.children}</Suspense>
    );
  }
}
