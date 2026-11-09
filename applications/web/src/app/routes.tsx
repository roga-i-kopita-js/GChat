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
            Component: async (): Promise<typeof import('../features/auth/LoginPage').LoginPage> => {
              const { LoginPage: resultLoginPage } = await import('../features/auth/LoginPage');

              return resultLoginPage;
            },
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
                > => {
                  const { adminGroupsLoader: resultAdminGroupsLoader } =
                    await import('../features/administration/routes');

                  return resultAdminGroupsLoader;
                },
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
                    > => {
                      const { contactsLoader: resultContactsLoader } =
                        await import('../features/calls/contacts');

                      return resultContactsLoader;
                    },
                    Component: async (): Promise<
                      typeof import('../features/calls/CallsPage').CallsPage
                    > => {
                      const { CallsPage: resultCallsPage } =
                        await import('../features/calls/CallsPage');

                      return resultCallsPage;
                    },
                  },
                },
                {
                  path: 'dialogs',
                  ErrorBoundary: RouteErrorBoundary,
                  lazy: {
                    Component: async (): Promise<
                      typeof import('../features/dialogs/DialogsPage').DialogsPage
                    > => {
                      const { DialogsPage: resultDialogsPage } =
                        await import('../features/dialogs/DialogsPage');

                      return resultDialogsPage;
                    },
                  },
                  children: [
                    {
                      index: true,
                      lazy: {
                        Component: async (): Promise<
                          typeof import('../features/dialogs/DialogIndexRoute').DialogIndexRoute
                        > => {
                          const { DialogIndexRoute: resultDialogIndexRoute } =
                            await import('../features/dialogs/DialogIndexRoute');

                          return resultDialogIndexRoute;
                        },
                      },
                    },
                    {
                      path: ':dialogId',
                      ErrorBoundary: RouteErrorBoundary,
                      lazy: {
                        Component: async (): Promise<
                          typeof import('../features/dialogs/DialogConversationRoute').DialogConversationRoute
                        > => {
                          const { DialogConversationRoute: resultDialogConversationRoute } =
                            await import('../features/dialogs/DialogConversationRoute');

                          return resultDialogConversationRoute;
                        },
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
                        > => {
                          const { SettingsIndexRoute: resultSettingsIndexRoute } =
                            await import('../features/settings/SettingsIndexRoute');

                          return resultSettingsIndexRoute;
                        },
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
                            > => {
                              const { SettingsGeneralRoute: resultSettingsGeneralRoute } =
                                await import('../features/settings/SettingsGeneralRoute');

                              return resultSettingsGeneralRoute;
                            },
                          },
                        },
                        {
                          path: 'microphone',
                          lazy: {
                            Component: async (): Promise<
                              typeof import('../features/settings/SettingsMicrophoneRoute').SettingsMicrophoneRoute
                            > => {
                              const { SettingsMicrophoneRoute: resultSettingsMicrophoneRoute } =
                                await import('../features/settings/SettingsMicrophoneRoute');

                              return resultSettingsMicrophoneRoute;
                            },
                          },
                        },
                        {
                          path: 'audio',
                          lazy: {
                            Component: async (): Promise<
                              typeof import('../features/settings/SettingsAudioRoute').SettingsAudioRoute
                            > => {
                              const { SettingsAudioRoute: resultSettingsAudioRoute } =
                                await import('../features/settings/SettingsAudioRoute');

                              return resultSettingsAudioRoute;
                            },
                          },
                        },
                        {
                          path: 'push',
                          lazy: {
                            Component: async (): Promise<
                              typeof import('../features/settings/SettingsPushRoute').SettingsPushRoute
                            > => {
                              const { SettingsPushRoute: resultSettingsPushRoute } =
                                await import('../features/settings/SettingsPushRoute');

                              return resultSettingsPushRoute;
                            },
                          },
                        },
                        {
                          path: 'camera',
                          lazy: {
                            Component: async (): Promise<
                              typeof import('../features/settings/SettingsCameraRoute').SettingsCameraRoute
                            > => {
                              const { SettingsCameraRoute: resultSettingsCameraRoute } =
                                await import('../features/settings/SettingsCameraRoute');

                              return resultSettingsCameraRoute;
                            },
                          },
                        },
                        {
                          path: 'geolocation',
                          lazy: {
                            Component: async (): Promise<
                              typeof import('../features/settings/SettingsGeolocationRoute').SettingsGeolocationRoute
                            > => {
                              const { SettingsGeolocationRoute: resultSettingsGeolocationRoute } =
                                await import('../features/settings/SettingsGeolocationRoute');

                              return resultSettingsGeolocationRoute;
                            },
                          },
                        },
                        {
                          path: 'files',
                          lazy: {
                            Component: async (): Promise<
                              typeof import('../features/settings/SettingsFilesRoute').SettingsFilesRoute
                            > => {
                              const { SettingsFilesRoute: resultSettingsFilesRoute } =
                                await import('../features/settings/SettingsFilesRoute');

                              return resultSettingsFilesRoute;
                            },
                          },
                        },
                      ],
                    },
                    {
                      path: '*',
                      lazy: {
                        Component: async (): Promise<
                          typeof import('../features/settings/SettingsMissingRoute').SettingsMissingRoute
                        > => {
                          const { SettingsMissingRoute: resultSettingsMissingRoute } =
                            await import('../features/settings/SettingsMissingRoute');

                          return resultSettingsMissingRoute;
                        },
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
                        > => {
                          const { adminUsersLoader: resultAdminUsersLoader } =
                            await import('../features/administration/routes');

                          return resultAdminUsersLoader;
                        },
                        action: async (): Promise<
                          typeof import('../features/administration/routes').adminAction
                        > => {
                          const { adminAction: resultAdminAction } =
                            await import('../features/administration/routes');

                          return resultAdminAction;
                        },
                        Component: async (): Promise<
                          typeof import('../features/administration/UsersRoute').AdminUsersRoute
                        > => {
                          const { AdminUsersRoute: resultAdminUsersRoute } =
                            await import('../features/administration/UsersRoute');

                          return resultAdminUsersRoute;
                        },
                      },
                      children: [
                        {
                          id: 'admin-user',
                          path: ':userId',
                          ErrorBoundary: RouteErrorBoundary,
                          lazy: {
                            loader: async (): Promise<
                              typeof import('../features/administration/routes').adminUserLoader
                            > => {
                              const { adminUserLoader: resultAdminUserLoader } =
                                await import('../features/administration/routes');

                              return resultAdminUserLoader;
                            },
                            Component: async (): Promise<
                              typeof import('../features/administration/UsersPage').UserDetailRoute
                            > => {
                              const { UserDetailRoute: resultUserDetailRoute } =
                                await import('../features/administration/UsersPage');

                              return resultUserDetailRoute;
                            },
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
