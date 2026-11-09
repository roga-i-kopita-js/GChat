import { Link, Navigate, Outlet, type RouteObject } from 'react-router';

import { App, RequireAdmin, RequireSession } from './App';
import { AppLayout } from './AppLayout';
import { routeLoadingMiddleware } from './layout/route-loading';
import { layoutRoute } from './layout/sections';
import { applicationLoader, loginLoader } from './loaders';
import { RouteErrorBoundary } from './RouteErrorBoundary';
import { sessionMiddleware } from './session-middleware';

export function createApplicationRoutes(): RouteObject[] {
  return [
    {
      id: 'application',
      loader: applicationLoader,
      Component: App,
      ErrorBoundary: RouteErrorBoundary,
      hydrateFallbackElement: <main role="status">Загружаем GChat…</main>,
      children: [
        {
          path: '/login',
          loader: loginLoader,
          ErrorBoundary: RouteErrorBoundary,
          lazy: {
            Component: async (): Promise<typeof import('../features/auth/LoginPage').LoginPage> =>
              (await import('../features/auth/LoginPage')).LoginPage,
          },
        },
        {
          middleware: [sessionMiddleware],
          Component: RequireSession,
          ErrorBoundary: RouteErrorBoundary,
          children: [
            {
              path: '/resources/admin/groups',
              lazy: {
                loader: async (): Promise<
                  typeof import('../features/administration/routes').adminGroupsLoader
                > => (await import('../features/administration/routes')).adminGroupsLoader,
              },
            },
            {
              Component: AppLayout,
              middleware: [routeLoadingMiddleware],
              children: [
                {
                  index: true,
                  handle: layoutRoute('calls'),
                  element: <Navigate to="/calls" replace />,
                },
                {
                  id: 'contacts',
                  path: 'calls',
                  handle: layoutRoute('calls'),
                  ErrorBoundary: RouteErrorBoundary,
                  lazy: {
                    loader: async (): Promise<
                      typeof import('../features/calls/contacts').contactsLoader
                    > => (await import('../features/calls/contacts')).contactsLoader,
                    Component: async (): Promise<
                      typeof import('../features/calls/CallsPage').CallsPage
                    > => (await import('../features/calls/CallsPage')).CallsPage,
                  },
                },
                {
                  path: 'dialogs',
                  handle: layoutRoute('dialogs', 'contained'),
                  ErrorBoundary: RouteErrorBoundary,
                  lazy: {
                    Component: async (): Promise<
                      typeof import('../features/dialogs/DialogsPage').DialogsPage
                    > => (await import('../features/dialogs/DialogsPage')).DialogsPage,
                  },
                  children: [
                    {
                      id: 'dialog-index',
                      index: true,
                      lazy: {
                        loader: async (): Promise<
                          typeof import('../features/dialogs/loaders').dialogsLoader
                        > => (await import('../features/dialogs/loaders')).dialogsLoader,
                        Component: async (): Promise<
                          typeof import('../features/dialogs/DialogIndexRoute').DialogIndexRoute
                        > =>
                          (await import('../features/dialogs/DialogIndexRoute')).DialogIndexRoute,
                      },
                    },
                    {
                      id: 'dialog-conversation',
                      path: ':dialogId',
                      ErrorBoundary: RouteErrorBoundary,
                      lazy: {
                        loader: async (): Promise<
                          typeof import('../features/dialogs/loaders').dialogsLoader
                        > => (await import('../features/dialogs/loaders')).dialogsLoader,
                        Component: async (): Promise<
                          typeof import('../features/dialogs/DialogConversationRoute').DialogConversationRoute
                        > =>
                          (await import('../features/dialogs/DialogConversationRoute'))
                            .DialogConversationRoute,
                      },
                    },
                  ],
                },
                {
                  path: 'settings',
                  handle: layoutRoute('settings'),
                  Component: Outlet,
                  ErrorBoundary: RouteErrorBoundary,
                  children: [
                    {
                      index: true,
                      lazy: {
                        loader: async (): Promise<
                          typeof import('../features/settings/loaders').settingsProfileLoader
                        > => (await import('../features/settings/loaders')).settingsProfileLoader,
                        Component: async (): Promise<
                          typeof import('../features/settings/SettingsIndexRoute').SettingsIndexRoute
                        > =>
                          (await import('../features/settings/SettingsIndexRoute'))
                            .SettingsIndexRoute,
                      },
                    },
                    {
                      path: 'general',
                      handle: layoutRoute('settings'),
                      Component: Outlet,
                      children: [
                        {
                          index: true,
                          lazy: {
                            loader: async (): Promise<
                              typeof import('../features/settings/loaders').settingsLoader
                            > => (await import('../features/settings/loaders')).settingsLoader,
                            Component: async (): Promise<
                              typeof import('../features/settings/SettingsGeneralRoute').SettingsGeneralRoute
                            > =>
                              (await import('../features/settings/SettingsGeneralRoute'))
                                .SettingsGeneralRoute,
                          },
                        },
                        {
                          path: 'microphone',
                          handle: layoutRoute('settings'),
                          lazy: {
                            loader: async (): Promise<
                              typeof import('../features/settings/loaders').settingsLoader
                            > => (await import('../features/settings/loaders')).settingsLoader,
                            Component: async (): Promise<
                              typeof import('../features/settings/SettingsMicrophoneRoute').SettingsMicrophoneRoute
                            > =>
                              (await import('../features/settings/SettingsMicrophoneRoute'))
                                .SettingsMicrophoneRoute,
                          },
                        },
                        {
                          path: 'audio',
                          handle: layoutRoute('settings'),
                          lazy: {
                            loader: async (): Promise<
                              typeof import('../features/settings/loaders').settingsLoader
                            > => (await import('../features/settings/loaders')).settingsLoader,
                            Component: async (): Promise<
                              typeof import('../features/settings/SettingsAudioRoute').SettingsAudioRoute
                            > =>
                              (await import('../features/settings/SettingsAudioRoute'))
                                .SettingsAudioRoute,
                          },
                        },
                        {
                          path: 'push',
                          handle: layoutRoute('settings'),
                          lazy: {
                            loader: async (): Promise<
                              typeof import('../features/settings/loaders').settingsLoader
                            > => (await import('../features/settings/loaders')).settingsLoader,
                            Component: async (): Promise<
                              typeof import('../features/settings/SettingsPushRoute').SettingsPushRoute
                            > =>
                              (await import('../features/settings/SettingsPushRoute'))
                                .SettingsPushRoute,
                          },
                        },
                        {
                          path: 'camera',
                          handle: layoutRoute('settings'),
                          lazy: {
                            loader: async (): Promise<
                              typeof import('../features/settings/loaders').settingsLoader
                            > => (await import('../features/settings/loaders')).settingsLoader,
                            Component: async (): Promise<
                              typeof import('../features/settings/SettingsCameraRoute').SettingsCameraRoute
                            > =>
                              (await import('../features/settings/SettingsCameraRoute'))
                                .SettingsCameraRoute,
                          },
                        },
                        {
                          path: 'geolocation',
                          handle: layoutRoute('settings'),
                          lazy: {
                            loader: async (): Promise<
                              typeof import('../features/settings/loaders').settingsLoader
                            > => (await import('../features/settings/loaders')).settingsLoader,
                            Component: async (): Promise<
                              typeof import('../features/settings/SettingsGeolocationRoute').SettingsGeolocationRoute
                            > =>
                              (await import('../features/settings/SettingsGeolocationRoute'))
                                .SettingsGeolocationRoute,
                          },
                        },
                        {
                          path: 'files',
                          handle: layoutRoute('settings'),
                          lazy: {
                            loader: async (): Promise<
                              typeof import('../features/settings/loaders').settingsFilesLoader
                            > => (await import('../features/settings/loaders')).settingsFilesLoader,
                            Component: async (): Promise<
                              typeof import('../features/settings/SettingsFilesRoute').SettingsFilesRoute
                            > =>
                              (await import('../features/settings/SettingsFilesRoute'))
                                .SettingsFilesRoute,
                          },
                        },
                      ],
                    },
                    {
                      path: '*',
                      handle: layoutRoute('settings'),
                      lazy: {
                        loader: async (): Promise<
                          typeof import('../features/settings/loaders').settingsLoader
                        > => (await import('../features/settings/loaders')).settingsLoader,
                        Component: async (): Promise<
                          typeof import('../features/settings/SettingsMissingRoute').SettingsMissingRoute
                        > =>
                          (await import('../features/settings/SettingsMissingRoute'))
                            .SettingsMissingRoute,
                      },
                    },
                  ],
                },
                {
                  path: 'admin',
                  handle: layoutRoute('admin'),
                  Component: RequireAdmin,
                  ErrorBoundary: RouteErrorBoundary,
                  children: [
                    { index: true, element: <Navigate to="users" replace /> },
                    {
                      id: 'admin-users',
                      path: 'users',
                      ErrorBoundary: RouteErrorBoundary,
                      lazy: {
                        loader: async (): Promise<
                          typeof import('../features/administration/routes').adminUsersLoader
                        > => (await import('../features/administration/routes')).adminUsersLoader,
                        action: async (): Promise<
                          typeof import('../features/administration/routes').adminAction
                        > => (await import('../features/administration/routes')).adminAction,
                        Component: async (): Promise<
                          typeof import('../features/administration/UsersRoute').AdminUsersRoute
                        > =>
                          (await import('../features/administration/UsersRoute')).AdminUsersRoute,
                      },
                      children: [
                        {
                          id: 'admin-user',
                          path: ':userId',
                          ErrorBoundary: RouteErrorBoundary,
                          lazy: {
                            loader: async (): Promise<
                              typeof import('../features/administration/routes').adminUserLoader
                            > =>
                              (await import('../features/administration/routes')).adminUserLoader,
                            Component: async (): Promise<
                              typeof import('../features/administration/UsersPage').UserDetailRoute
                            > =>
                              (await import('../features/administration/UsersPage'))
                                .UserDetailRoute,
                          },
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          path: '*',
          element: (
            <main className="list-empty">
              <h1>Страница не найдена</h1>
              <Link className="primary" to="/calls">
                К звонкам
              </Link>
            </main>
          ),
        },
      ],
    },
  ];
}
