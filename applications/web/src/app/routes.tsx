import { Link, Navigate, Outlet, type RouteObject } from 'react-router';

import { App, RequireAdmin, RequireSession } from './App';
import { AppLayout } from './AppLayout';
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
              children: [
                { index: true, element: <Navigate to="/calls" replace /> },
                {
                  id: 'contacts',
                  path: 'calls',
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
                  ErrorBoundary: RouteErrorBoundary,
                  lazy: {
                    Component: async (): Promise<
                      typeof import('../features/dialogs/DialogsPage').DialogsPage
                    > => (await import('../features/dialogs/DialogsPage')).DialogsPage,
                  },
                  children: [
                    {
                      index: true,
                      lazy: {
                        Component: async (): Promise<
                          typeof import('../features/dialogs/DialogIndexRoute').DialogIndexRoute
                        > =>
                          (await import('../features/dialogs/DialogIndexRoute')).DialogIndexRoute,
                      },
                    },
                    {
                      path: ':dialogId',
                      ErrorBoundary: RouteErrorBoundary,
                      lazy: {
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
                  Component: Outlet,
                  ErrorBoundary: RouteErrorBoundary,
                  children: [
                    {
                      index: true,
                      lazy: {
                        Component: async (): Promise<
                          typeof import('../features/settings/SettingsIndexRoute').SettingsIndexRoute
                        > =>
                          (await import('../features/settings/SettingsIndexRoute'))
                            .SettingsIndexRoute,
                      },
                    },
                    {
                      path: 'general',
                      Component: Outlet,
                      children: [
                        {
                          index: true,
                          lazy: {
                            Component: async (): Promise<
                              typeof import('../features/settings/SettingsGeneralRoute').SettingsGeneralRoute
                            > =>
                              (await import('../features/settings/SettingsGeneralRoute'))
                                .SettingsGeneralRoute,
                          },
                        },
                        {
                          path: 'microphone',
                          lazy: {
                            Component: async (): Promise<
                              typeof import('../features/settings/SettingsMicrophoneRoute').SettingsMicrophoneRoute
                            > =>
                              (await import('../features/settings/SettingsMicrophoneRoute'))
                                .SettingsMicrophoneRoute,
                          },
                        },
                        {
                          path: 'audio',
                          lazy: {
                            Component: async (): Promise<
                              typeof import('../features/settings/SettingsAudioRoute').SettingsAudioRoute
                            > =>
                              (await import('../features/settings/SettingsAudioRoute'))
                                .SettingsAudioRoute,
                          },
                        },
                        {
                          path: 'push',
                          lazy: {
                            Component: async (): Promise<
                              typeof import('../features/settings/SettingsPushRoute').SettingsPushRoute
                            > =>
                              (await import('../features/settings/SettingsPushRoute'))
                                .SettingsPushRoute,
                          },
                        },
                        {
                          path: 'camera',
                          lazy: {
                            Component: async (): Promise<
                              typeof import('../features/settings/SettingsCameraRoute').SettingsCameraRoute
                            > =>
                              (await import('../features/settings/SettingsCameraRoute'))
                                .SettingsCameraRoute,
                          },
                        },
                        {
                          path: 'geolocation',
                          lazy: {
                            Component: async (): Promise<
                              typeof import('../features/settings/SettingsGeolocationRoute').SettingsGeolocationRoute
                            > =>
                              (await import('../features/settings/SettingsGeolocationRoute'))
                                .SettingsGeolocationRoute,
                          },
                        },
                        {
                          path: 'files',
                          lazy: {
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
                      lazy: {
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
