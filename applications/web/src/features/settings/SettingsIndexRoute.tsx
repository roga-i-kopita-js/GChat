import { LogOut, Settings } from 'lucide-react';
import type { JSX } from 'react';
import { useEffect, useState } from 'react';

import { deviceErrorMessage } from '../../shared/device/messages';
import { useDevice } from '../../shared/device/react';
import { Avatar, Modal } from '../../shared/ui';
import { useAuth } from '../auth/AuthProvider';
import { useCalls } from '../calls/CallsProvider';
import { Group, Row, SettingsScreen } from './ui';

export function SettingsIndexRoute(): JSX.Element {
  const { user } = useAuth();
  const device = useDevice();
  const { ongoing, incoming } = useCalls();
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [error, setError] = useState('');

  useEffect((): void => {
    if (incoming) {
      setConfirmLogout(false);
    }
  }, [incoming]);

  if (!user) {
    return <></>;
  }

  return (
    <SettingsScreen title="Настройки">
      <div className="settings-profile">
        <Avatar name={user.display_name} large />
        <h2>{user.display_name}</h2>
        <p>@{user.login}</p>
      </div>
      <Group>
        <Row icon={Settings} color="#8e8e93" title="Основные" to="/settings/general" />
      </Group>
      <Group>
        <button
          className="settings-action settings-danger"
          onClick={(): void => setConfirmLogout(true)}
        >
          Выйти из аккаунта
        </button>
      </Group>
      <p className="settings-note">GChat · Настройки устройства</p>
      {confirmLogout && (
        <Modal title="Выйти из GChat?" close={(): void => setConfirmLogout(false)}>
          <p>
            {ongoing ? 'Активный разговор закончится.' : 'Вы сможете войти снова.'} Разрешения
            устройства сохранятся.
          </p>
          <div className="modal-actions">
            <button className="secondary" onClick={(): void => setConfirmLogout(false)}>
              Отмена
            </button>
            <button
              className="danger-button"
              onClick={(): void => {
                setConfirmLogout(false);
                void (async () => {
                  try {
                    return await device.session.logout();
                  } catch (cause) {
                    return setError(deviceErrorMessage(cause));
                  }
                })();
              }}
            >
              <LogOut size={17} /> Выйти
            </button>
          </div>
        </Modal>
      )}
      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
    </SettingsScreen>
  );
}
