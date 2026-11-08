import type { JSX } from 'react';
import {
  createBrowserRouter,
  type DataRouter,
  type RouteObject,
  type RouterContextProvider,
  RouterProvider,
} from 'react-router';

import { DeviceNavigation } from './navigation';

/** Owns the single Data router while application routes remain in app. */
export class NavigationHost {
  readonly navigation: DeviceNavigation;
  private readonly router: DataRouter;

  constructor(
    routes: RouteObject[],
    basename: string,
    resolveLocation: (to: string) => string,
    getContext: () => RouterContextProvider,
  ) {
    this.router = createBrowserRouter(routes, { basename, getContext });
    this.navigation = new DeviceNavigation(
      this.router,
      resolveLocation,
      basename === '/' ? '' : basename,
    );
  }

  dispose(): void {
    this.navigation.stop();
    this.router.dispose();
  }

  render(): JSX.Element {
    return <RouterProvider router={this.router} />;
  }
}
