import { File, Folder } from 'lucide-react';
import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';

import { DeviceError, type FileRef } from '../../shared/device/contract';
import { deviceErrorMessage } from '../../shared/device/messages';
import { Modal } from '../../shared/ui';
import { useCalls } from '../calls/CallsProvider';
import { descriptions, titles } from './labels';
import { Group, Row, SettingsAction, SettingsScreen } from './ui';
import { useSettingsDevice } from './useSettingsDevice';

export function SettingsFilesRoute(): JSX.Element {
  const device = useSettingsDevice();
  const { state, api, run, setBusy, setError, busy } = device;
  const { incoming } = useCalls();
  const [entries, setEntries] = useState<FileRef[]>([]);
  const [lostAccess, setLostAccess] = useState<Set<string>>(new Set());
  const [forget, setForget] = useState<FileRef | null>(null);
  const generation = useRef(0);

  useEffect((): (() => void) => {
    return (): void => {
      generation.current++;
    };
  }, []);
  useEffect((): (() => void) => {
    let cancelled = false;

    async function load(): Promise<void> {
      const all: FileRef[] = [];
      let cursor: string | null = null;

      do {
        const page = await api.files.listAccesses({ cursor, limit: 100 });

        if (cancelled) {
          return;
        }

        all.push(...page.entries);
        cursor = page.nextCursor;
      } while (cursor);

      setEntries(all);
    }

    if (state) {
      void load().catch((cause: unknown): void => {
        if (!cancelled) {
          setError(deviceErrorMessage(cause));
        }
      });
    }

    return (): void => {
      cancelled = true;
    };
  }, [api, state]);
  useEffect((): void => {
    if (incoming) {
      setForget(null);
    }
  }, [incoming]);
  async function verifyAccess(entry: FileRef): Promise<void> {
    const epoch = generation.current;

    setBusy(true);
    setError('');

    try {
      await api.files.restoreAccess(entry);

      if (epoch === generation.current) {
        setLostAccess((old): Set<string> => {
          const next = new Set(old);

          next.delete(entry.id);

          return next;
        });
      }
    } catch (cause) {
      if (epoch === generation.current) {
        setError(deviceErrorMessage(cause));

        if (
          cause instanceof DeviceError &&
          ['ACCESS_LOST', 'NOT_FOUND', 'PERMISSION_DENIED'].includes(cause.code)
        ) {
          setLostAccess((old): Set<string> => new Set([...old, entry.id]));
        }
      }
    } finally {
      if (epoch === generation.current) {
        setBusy(false);
      }
    }
  }

  const action = (label: string, onClick: () => void): JSX.Element => (
    <SettingsAction device={device} onClick={onClick}>
      {label}
    </SettingsAction>
  );

  return (
    <SettingsScreen title={titles.files} parent="/settings/general" device={device}>
      <p className="settings-intro">{descriptions.files}</p>
      <Group>
        {action('Выбрать файл', (): void => {
          void run((): ReturnType<typeof device.api.files.pick> =>
            device.api.files.pick({ multiple: true, accept: [] }),
          );
        })}
        {action('Выбрать папку', (): void => {
          void run((): ReturnType<typeof device.api.files.pickDirectory> =>
            device.api.files.pickDirectory(),
          );
        })}
      </Group>
      {entries.length ? (
        <Group title="Предоставленный доступ">
          {entries.map((entry): JSX.Element => (
            <div key={entry.id}>
              <Row
                icon={entry.kind === 'directory' ? Folder : File}
                color="#30b0c7"
                title={entry.name}
              >
                <small>
                  {lostAccess.has(entry.id)
                    ? 'Нужно выбрать заново'
                    : entry.persistence === 'persistent'
                      ? 'Сохранённый доступ'
                      : 'До закрытия приложения'}
                </small>
              </Row>
              <div className="settings-file-actions">
                <button
                  disabled={busy}
                  onClick={(): void => {
                    void verifyAccess(entry);
                  }}
                >
                  Проверить доступ
                </button>
                <button disabled={busy} onClick={(): void => setForget(entry)}>
                  Забыть доступ
                </button>
              </div>
            </div>
          ))}
        </Group>
      ) : (
        <p className="settings-note">
          Пока нет выбранных файлов и папок. Вы предоставляете доступ только к тому, что выбрали
          сами.
        </p>
      )}
      {forget && (
        <Modal title="Забыть доступ?" close={(): void => setForget(null)}>
          <p>
            Файл «{forget.name}» останется на устройстве. Для следующего обращения потребуется
            выбрать его заново.
          </p>
          <div className="modal-actions">
            <button className="secondary" onClick={(): void => setForget(null)}>
              Отмена
            </button>
            <button
              className="danger-button"
              onClick={(): void => {
                void run((): ReturnType<typeof device.api.files.forgetAccess> =>
                  device.api.files.forgetAccess(forget),
                );
                setForget(null);
              }}
            >
              Забыть доступ
            </button>
          </div>
        </Modal>
      )}
    </SettingsScreen>
  );
}
