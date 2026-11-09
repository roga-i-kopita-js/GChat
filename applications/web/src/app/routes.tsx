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
                  handle: layoutRoute('dialogs', 'contained'),
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
                      id: 'dialog-index',
                      index: true,
                      lazy: {
                        loader: async (): Promise<
                          typeof import('../features/dialogs/loaders').dialogsLoader
                        > => {
                          const { dialogsLoader: resultDialogsLoader } =
                            await import('../features/dialogs/loaders');

                          return resultDialogsLoader;
                        },
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
                      id: 'dialog-conversation',
                      path: ':dialogId',
                      ErrorBoundary: RouteErrorBoundary,
                      lazy: {
                        loader: async (): Promise<
                          typeof import('../features/dialogs/loaders').dialogsLoader
                        > => {
                          const { dialogsLoader: resultDialogsLoader2 } =
                            await import('../features/dialogs/loaders');

                          return resultDialogsLoader2;
                        },
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
                  handle: layoutRoute('settings'),
                  Component: Outlet,
                  ErrorBoundary: RouteErrorBoundary,
                  children: [
                    {
                      index: true,
                      lazy: {
                        loader: async (): Promise<
                          typeof import('../features/settings/loaders').settingsProfileLoader
                        > => {
                          const { settingsProfileLoader: resultSettingsProfileLoader } =
                            await import('../features/settings/loaders');

                          return resultSettingsProfileLoader;
                        },
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
                      handle: layoutRoute('settings'),
                      Component: Outlet,
                      children: [
                        {
                          index: true,
                          lazy: {
                            loader: async (): Promise<
                              typeof import('../features/settings/loaders').settingsLoader
                            > => {
                              const { settingsLoader: resultSettingsLoader } =
                                await import('../features/settings/loaders');

                              return resultSettingsLoader;
                            },
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
                          handle: layoutRoute('settings'),
                          lazy: {
                            loader: async (): Promise<
                              typeof import('../features/settings/loaders').settingsLoader
                            > => {
                              const { settingsLoader: resultSettingsLoader2 } =
                                await import('../features/settings/loaders');

                              return resultSettingsLoader2;
                            },
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
                          handle: layoutRoute('settings'),
                          lazy: {
                            loader: async (): Promise<
                              typeof import('../features/settings/loaders').settingsLoader
                            > => {
                              const { settingsLoader: resultSettingsLoader3 } =
                                await import('../features/settings/loaders');

                              return resultSettingsLoader3;
                            },
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
                          handle: layoutRoute('settings'),
                          lazy: {
                            loader: async (): Promise<
                              typeof import('../features/settings/loaders').settingsLoader
                            > => {
                              const { settingsLoader: resultSettingsLoader4 } =
                                await import('../features/settings/loaders');

                              return resultSettingsLoader4;
                            },
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
                          handle: layoutRoute('settings'),
                          lazy: {
                            loader: async (): Promise<
                              typeof import('../features/settings/loaders').settingsLoader
                            > => {
                              const { settingsLoader: resultSettingsLoader5 } =
                                await import('../features/settings/loaders');

                              return resultSettingsLoader5;
                            },
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
                          handle: layoutRoute('settings'),
                          lazy: {
                            loader: async (): Promise<
                              typeof import('../features/settings/loaders').settingsLoader
                            > => {
                              const { settingsLoader: resultSettingsLoader6 } =
                                await import('../features/settings/loaders');

                              return resultSettingsLoader6;
                            },
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
                          handle: layoutRoute('settings'),
                          lazy: {
                            loader: async (): Promise<
                              typeof import('../features/settings/loaders').settingsFilesLoader
                            > => {
                              const { settingsFilesLoader: resultSettingsFilesLoader } =
                                await import('../features/settings/loaders');

                              return resultSettingsFilesLoader;
                            },
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
                      handle: layoutRoute('settings'),
                      lazy: {
                        loader: async (): Promise<
                          typeof import('../features/settings/loaders').settingsLoader
                        > => {
                          const { settingsLoader: resultSettingsLoader7 } =
                            await import('../features/settings/loaders');

                          return resultSettingsLoader7;
                        },
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
