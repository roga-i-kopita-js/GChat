import { Code2, LogOut, Phone, ShieldCheck, Volume2, X } from 'lucide-react';
import type { JSX } from 'react';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router';

import { useAuth } from '../features/auth/AuthProvider';
import { AudioControls } from '../features/calls/AudioControls';
import { useCalls } from '../features/calls/CallsProvider';
import { DiagnosticsDialog } from '../features/calls/DiagnosticsDialog';
import { WebPushControls } from '../features/calls/WebPushControls';
import { errorMessage } from '../shared/api/client';
import { embedded } from '../shared/native/bridge';
import { nativeRuntime } from '../shared/native/runtime';
import { Avatar, Modal } from '../shared/ui';
import { useDebug } from '../shared/useDebug';

export function AppLayout(): JSX.Element {
  const { user } = useAuth();
  const native = useSyncExternalStore(nativeRuntime.subscribe, nativeRuntime.getSnapshot);
  const debug = useDebug();
  const { client, state, call, incoming, ongoing } = useCalls();
  const admin = useLocation().pathname.startsWith('/admin');
  const [account, setAccount] = useState(false);
  const [accountError, setAccountError] = useState('');
  const [diagnostics, setDiagnostics] = useState(false);

  useEffect((): void => {
    if (incoming) {
      setAccount(false);
    }

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
        <button className="profile" title="Мой аккаунт" onClick={(): void => setAccount(true)}>
          <Avatar name={user.display_name} />
          <span className="profile-identity">
            <strong>{user.display_name}</strong>
            <small>@{user.login}</small>
          </span>
        </button>
      </header>
      <main
        className={'workspace' + (admin ? ' admin-active' : '')}
        aria-label={admin ? 'Администрирование' : 'Звонки'}
      >
        {!state.owner ? (
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
        ) : null}
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
        {admin && call && (
          <Link className="secondary admin-call-return" to="/calls">
            <Phone size={17} /> Вернуться к звонку
          </Link>
        )}
        <Outlet />
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
      </main>
      <nav className="bottom-navigation" aria-label="Основные разделы">
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
      </nav>
      {account && (
        <Modal title="Мой аккаунт" close={(): void => setAccount(false)}>
          <div className="account-person">
            <Avatar name={user.display_name} large />
            <h3>{user.display_name}</h3>
            <p>@{user.login}</p>
          </div>
          <p>
            {ongoing
              ? 'При выходе текущая сессия будет завершена. Активный разговор закончится.'
              : 'Вы сможете снова войти с теми же логином и паролем.'}
          </p>
          <WebPushControls />
          <AudioControls />
          {accountError && (
            <p role="alert" className="form-error">
              {accountError}
            </p>
          )}
          <button
            className="danger-button"
            onClick={(): void => {
              void client
                .signOut()
                .catch((cause: unknown): void =>
                  setAccountError(errorMessage(cause, 'Не удалось подтвердить выход')),
                );
            }}
          >
            <LogOut size={18} /> {ongoing ? 'Завершить звонок и выйти' : 'Выйти из аккаунта'}
          </button>
        </Modal>
      )}
      {debug && !embedded && diagnostics && (
        <DiagnosticsDialog close={(): void => setDiagnostics(false)} />
      )}
    </div>
  );
}
