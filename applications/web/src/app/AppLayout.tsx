import { Code2, MessageCircle, Phone, Settings, ShieldCheck, X } from 'lucide-react';
import type { JSX } from 'react';
import { lazy, useEffect, useState, useSyncExternalStore } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router';

import { useAuth } from '../features/auth/AuthProvider';
import { useCalls } from '../features/calls/CallsProvider';
import { useDevice, useDevicePresentation } from '../shared/device/react';
import { LazyPanel } from '../shared/ui/LazyPanel';
import { useDebug } from '../shared/useDebug';

const DiagnosticsDialog = lazy(
  async (): Promise<{
    default: typeof import('../features/calls/DiagnosticsDialog').DiagnosticsDialog;
  }> => {
    const { DiagnosticsDialog: resultDiagnosticsDialog } =
      await import('../features/calls/DiagnosticsDialog');

    return { default: resultDiagnosticsDialog };
  },
);

export function AppLayout(): JSX.Element {
  const device = useDevice();
  const presentation = useDevicePresentation();
  const { user } = useAuth();
  const debug = useDebug();
  const { state, incoming, ongoing, peerName, setMobile } = useCalls();
  const path = useLocation().pathname;
  const admin = path.startsWith('/admin');
  const settings = path.startsWith('/settings');
  const dialogs = path.startsWith('/dialogs');
  const returnToCall = ongoing && path !== '/calls';
  const [diagnostics, setDiagnostics] = useState(false);

  useEffect((): void => {
    if (incoming || !debug) {
      setDiagnostics(false);
    }
  }, [incoming, debug]);

  if (!user) {
    return <></>;
  }

  let pageTitle;

  if (settings) {
    pageTitle = 'Настройки';
  } else if (dialogs) {
    pageTitle = 'Диалоги';
  } else if (admin) {
    pageTitle = 'Администрирование';
  } else {
    pageTitle = 'Звонки';
  }

  let callBanner;

  if (!state.owner) {
    callBanner = (
      <div role="status" className="tab-banner">
        Звонками управляет другая вкладка GChat.
        <button
          onClick={(): void =>
            void (async () => {
              try {
                return await device.calls.takeControl();
              } catch (cause) {}
            })()
          }
          disabled={ongoing}
        >
          Открыть здесь
        </button>
      </div>
    );
  } else if (presentation.callControls === 'host' && !presentation.callingAvailable) {
    callBanner = (
      <div role="status" className="tab-banner">
        Звонки в этой сборке приложения пока недоступны.
      </div>
    );
  } else if (state.connection !== 'online') {
    callBanner = (
      <div role="status" className="tab-banner">
        Подключаем звонки… Кнопки станут доступны после подключения.
      </div>
    );
  } else {
    callBanner = null;
  }

  return (
    <div
      className={
        'app-shell' +
        (presentation.callControls === 'host' ? ' app-shell-native' : '') +
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
        aria-label={pageTitle}
      >
        {!settings && !dialogs && callBanner}
        {state.error && (
          <div role="alert" className="error-banner">
            {state.error}
            <button
              className="icon"
              aria-label="Закрыть сообщение"
              onClick={(): void => device.calls.clearError()}
            >
              <X size={17} />
            </button>
          </div>
        )}
        <Outlet />
        {!settings && !dialogs && debug && presentation.callControls === 'application' && (
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
      {debug && presentation.callControls === 'application' && diagnostics && (
        <LazyPanel
          pending={<p role="status">Загружаем диагностику…</p>}
          failed={
            <div role="alert">
              <p>Не удалось загрузить диагностику.</p>
              <button onClick={(): void => setDiagnostics(false)}>Закрыть диагностику</button>
            </div>
          }
        >
          <DiagnosticsDialog close={(): void => setDiagnostics(false)} />
        </LazyPanel>
      )}
    </div>
  );
}
