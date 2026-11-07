import { Code2, MessageCircle, Phone, Settings, ShieldCheck, X } from 'lucide-react';
import type { JSX } from 'react';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router';

import { useAuth } from '../features/auth/AuthProvider';
import { useCalls } from '../features/calls/CallsProvider';
import { DiagnosticsDialog } from '../features/calls/DiagnosticsDialog';
import { embedded } from '../shared/native/bridge';
import { nativeRuntime } from '../shared/native/runtime';
import { useDebug } from '../shared/useDebug';

export function AppLayout(): JSX.Element {
  const { user } = useAuth();
  const native = useSyncExternalStore(nativeRuntime.subscribe, nativeRuntime.getSnapshot);
  const debug = useDebug();
  const { client, state, incoming, ongoing, peerName, setMobile } = useCalls();
  const path = useLocation().pathname;
  const admin = path.startsWith('/admin');
  const settings = path.startsWith('/settings');
  const dialogs = path.startsWith('/dialogs');
  const returnToCall = ongoing && path !== '/calls';
  const [diagnostics, setDiagnostics] = useState(false);

  useEffect((): void => {
    if (incoming || !debug) setDiagnostics(false);
  }, [incoming, debug]);

  if (!user) return <></>;

  return (
    <div
      className={
        'app-shell' +
        (embedded ? ' app-shell-native' : '') +
        (dialogs ? ' app-shell-dialogs' : '') +
        (returnToCall ? ' app-shell-with-call' : '')
      }
    >
      {returnToCall && (
        <Link className="ongoing-call-banner" to="/calls" onClick={(): void => setMobile(true)}>
          <Phone size={18} aria-hidden="true" />
          <span>Вернуться к звонку · {peerName}</span>
        </Link>
      )}
      <main
        className={
          'workspace' +
          (admin ? ' admin-active' : '') +
          (settings ? ' settings-active' : '') +
          (dialogs ? ' dialogs-active' : '')
        }
        aria-label={
          settings ? 'Настройки' : dialogs ? 'Диалоги' : admin ? 'Администрирование' : 'Звонки'
        }
      >
        {!settings &&
          !dialogs &&
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
        <Outlet />
        {!settings && !dialogs && debug && !embedded && (
          <footer className="workspace-footer">
            <button onClick={(): void => setDiagnostics(true)}>
              <Code2 size={14} /> Диагностика
            </button>
          </footer>
        )}
      </main>
      <nav className="bottom-navigation" aria-label="Основные разделы">
        <NavLink
          to="/calls"
          className={({ isActive }): string => 'bottom-tab' + (isActive ? ' active' : '')}
        >
          <Phone size={24} aria-hidden="true" />
          <span>Звонки</span>
        </NavLink>
        <NavLink
          to="/dialogs"
          className={({ isActive }): string => 'bottom-tab' + (isActive ? ' active' : '')}
        >
          <MessageCircle size={24} aria-hidden="true" />
          <span>Диалоги</span>
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
