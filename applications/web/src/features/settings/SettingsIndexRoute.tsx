import { LogOut, Settings } from 'lucide-react';
import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { useLoaderData } from 'react-router';

import { deviceErrorMessage } from '../../shared/device/messages';
import { Avatar, Button, Modal, Text } from '../../shared/ui';
import { useAuth } from '../auth/AuthProvider';
import { useCalls } from '../calls/CallsProvider';
import type { settingsProfileLoader } from './loaders';
import { Group, Row, SettingsScreen } from './ui';

export function SettingsIndexRoute(): JSX.Element {
  const { user } = useAuth();
  const { device, profile } = useLoaderData<Awaited<ReturnType<typeof settingsProfileLoader>>>();
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
        <Avatar name={profile.displayName} seed={profile.id} />
        <div>
          <Text as="h2" variant="label">
            {profile.displayName}
          </Text>
          <Text as="p" tone="muted">
            @{profile.login}
          </Text>
        </div>
      </div>
      <Group>
        <Row icon={Settings} title="Основные" to="/settings/general" />
      </Group>
      <Group>
        <Button
          variant="ghost"
          tone="danger"
          className="settings-action settings-danger"
          onClick={(): void => setConfirmLogout(true)}
        >
          Выйти из аккаунта
        </Button>
      </Group>
      <Text as="p" variant="caption" tone="muted" className="settings-note">
        GChat · Настройки устройства
      </Text>
      {confirmLogout && (
        <Modal title="Выйти из GChat?" close={(): void => setConfirmLogout(false)}>
          <Text as="p">
            {ongoing ? 'Активный разговор закончится.' : 'Вы сможете войти снова.'} Разрешения
            устройства сохранятся.
          </Text>
          <div className="modal-actions">
            <Button variant="secondary" onClick={(): void => setConfirmLogout(false)}>
              Отмена
            </Button>
            <Button
              variant="secondary"
              tone="danger"
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
            </Button>
          </div>
        </Modal>
      )}
      {error && (
        <Text as="p" tone="danger" className="settings-error" role="alert">
          {error}
        </Text>
      )}
    </SettingsScreen>
  );
}
