import { Code2, Phone, Settings, ShieldCheck, Volume2, X } from 'lucide-react';
import type { JSX } from 'react';
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router';

import { useAuth } from '../features/auth/AuthProvider';
import { useCalls } from '../features/calls/CallsProvider';
import { DiagnosticsDialog } from '../features/calls/DiagnosticsDialog';
import { embedded } from '../shared/native/bridge';
import { nativeRuntime } from '../shared/native/runtime';
import { Avatar } from '../shared/ui';
import { useDebug } from '../shared/useDebug';

export function AppLayout(): JSX.Element {
  const { user } = useAuth();
  const native = useSyncExternalStore(nativeRuntime.subscribe, nativeRuntime.getSnapshot);
  const debug = useDebug();
  const { client, state, call, incoming, ongoing } = useCalls();
  const path = useLocation().pathname;
  const admin = path.startsWith('/admin');
  const settings = path.startsWith('/settings');
  const navigation = useRef<HTMLElement | null>(null);

  useLayoutEffect((): (() => void) => {
    const nav = navigation.current;
    const shell = nav?.parentElement;

    if (!nav || !shell) return (): void => {};

    const measure = (): void =>
      shell.style.setProperty('--navigation-height', `${nav.offsetHeight}px`);
    const observer = new ResizeObserver(measure);

    observer.observe(nav);
    measure();

    return (): void => observer.disconnect();
  }, []);
  const [diagnostics, setDiagnostics] = useState(false);

  useEffect((): void => {
    if (incoming || !debug) setDiagnostics(false);
  }, [incoming, debug]);

  if (!user) return <></>;

  return (
    <div className="app-shell">
      <header className="app-header">
        <Link className="brand" to="/calls" aria-label="GChat — звонки">
          <span className="brand-mark" aria-hidden="true">
            <img
              src={`${import.meta.env.BASE_URL}icons/icon-192.png`}
              width="43"
              height="43"
              alt=""
            />
          </span>
        </Link>
        <Link className="profile" title="Настройки" to="/settings">
          <Avatar name={user.display_name} />
          <span className="profile-identity">
            <strong>{user.display_name}</strong>
            <small>@{user.login}</small>
          </span>
        </Link>
      </header>
      <main
        className={
          'workspace' + (admin ? ' admin-active' : '') + (settings ? ' settings-active' : '')
        }
        aria-label={settings ? 'Настройки' : admin ? 'Администрирование' : 'Звонки'}
      >
        {!settings &&
          (!state.owner ? (
            <div role="status" className="tab-banner">
              Звонками управляет другая вкладка GChat.
              <button onClick={(): void => client.activate()} disabled={ongoing}>
                Открыть здесь
              </button>
            </div>
          ) : embedded && native.nativeCalls === false ? (
            <div role="status" className="tab-banner">
              Звонки в этой сборке приложения пока недоступны.
            </div>
          ) : state.connection !== 'online' ? (
            <div role="status" className="tab-banner">
              Подключаем звонки… Кнопки станут доступны после подключения.
            </div>
          ) : null)}
        {state.error && (
          <div role="alert" className="error-banner">
            {state.error}
            <button
              className="icon"
              aria-label="Закрыть сообщение"
              onClick={(): void => client.clearError()}
            >
              <X size={17} />
            </button>
          </div>
        )}
        {(admin || settings) && call && call.state !== 'ended' && (
          <Link className="secondary admin-call-return" to="/calls">
            <Phone size={17} /> Вернуться к звонку
          </Link>
        )}
        <Outlet />
        {!settings && (
          <footer className="workspace-footer">
            <span>GChat Web</span>
            {state.owner && !state.audible && (
              <button
                onClick={(): void => {
                  void client.enableRingtone();
                }}
              >
                <Volume2 size={14} /> Включить звук звонков
              </button>
            )}
            {debug && !embedded && (
              <button onClick={(): void => setDiagnostics(true)}>
                <Code2 size={14} /> Диагностика
              </button>
            )}
          </footer>
        )}
      </main>
      <nav ref={navigation} className="bottom-navigation" aria-label="Основные разделы">
        <NavLink
          to="/calls"
          className={({ isActive }): string => 'bottom-tab' + (isActive ? ' active' : '')}
        >
          <Phone size={24} aria-hidden="true" />
          <span>Звонки</span>
        </NavLink>
        {user.role === 'admin' && (
          <NavLink
            to="/admin/users"
            className={({ isActive }): string => 'bottom-tab' + (isActive ? ' active' : '')}
          >
            <ShieldCheck size={24} aria-hidden="true" />
            <span>Администрирование</span>
          </NavLink>
        )}
        <NavLink
          to="/settings"
          className={({ isActive }): string => 'bottom-tab' + (isActive ? ' active' : '')}
        >
          <Settings size={24} aria-hidden="true" />
          <span>Настройки</span>
        </NavLink>
      </nav>
      {debug && !embedded && diagnostics && (
        <DiagnosticsDialog close={(): void => setDiagnostics(false)} />
      )}
    </div>
  );
}
