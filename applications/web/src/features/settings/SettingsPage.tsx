import './settings.css';

import {
  ArrowLeft,
  Bell,
  Camera,
  Check,
  ChevronRight,
  File,
  Folder,
  Headphones,
  LoaderCircle,
  LocateFixed,
  LogOut,
  type LucideIcon,
  Mic,
  Settings,
  ShieldCheck,
  Volume2,
  X,
} from 'lucide-react';
import type { CSSProperties, JSX, ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router';

import { useDeviceBridge } from '../../shared/device/context';
import {
  type Args,
  type Command,
  DeviceError,
  type DeviceState,
  type FileRef,
  type PermissionState,
  type Resource,
  type Result,
} from '../../shared/device/contract';
import { deviceErrorMessage } from '../../shared/device/messages';
import { Avatar, Modal } from '../../shared/ui';
import { useAuth } from '../auth/AuthProvider';
import { useCalls } from '../calls/CallsProvider';

const permissionLabels: Record<PermissionState['permission'], string> = {
  unknown: 'Неизвестно',
  prompt: 'Не запрошен',
  denied: 'Запрещён',
  restricted: 'Ограничен',
  granted: 'Разрешён',
  limited: 'Ограничен',
};
const descriptions: Record<string, string> = {
  microphone: 'Микрофон нужен, чтобы собеседник слышал вас во время звонка.',
  camera: 'Здесь можно разрешить доступ к камере. Съёмка фото и видео пока не используется.',
  geolocation:
    'Разрешение геопозиции при использовании приложения. Координаты не сохраняются и не отправляются.',
  audio: 'Проверьте слышимость короткого сигнала перед звонком.',
  push: 'Push-уведомления помогают узнать о входящем звонке, когда GChat закрыт.',
  files: 'Выберите файлы и папки, к которым GChat сможет обращаться на этом устройстве.',
};
const titles: Record<string, string> = {
  microphone: 'Микрофон',
  audio: 'Динамики и звук',
  push: 'Push-уведомления',
  camera: 'Камера',
  geolocation: 'Геопозиция',
  files: 'Файлы и папки',
};

function Badge({ icon: Icon, color }: { icon: LucideIcon; color: string }): JSX.Element {
  const style: CSSProperties = { backgroundColor: color };

  return (
    <span className="settings-icon" style={style}>
      <Icon size={19} aria-hidden="true" />
    </span>
  );
}
function Row({
  icon,
  color,
  title,
  value,
  to,
  children,
}: {
  icon: LucideIcon;
  color: string;
  title: string;
  value?: string;
  to?: string;
  children?: ReactNode;
}): JSX.Element {
  const body = (
    <>
      <Badge icon={icon} color={color} />
      <span className="settings-row-copy">
        <span>{title}</span>
        {children}
      </span>
      {value && <span className="settings-value">{value}</span>}
      {to && <ChevronRight className="settings-chevron" size={17} aria-hidden="true" />}
    </>
  );

  return to ? (
    <Link className="settings-row" to={to}>
      {body}
    </Link>
  ) : (
    <div className="settings-row">{body}</div>
  );
}
function Group({ title, children }: { title?: string; children: ReactNode }): JSX.Element {
  return (
    <section className="settings-group">
      {title && <h2>{title}</h2>}
      <div className="settings-surface">{children}</div>
    </section>
  );
}

export function SettingsPage(): JSX.Element {
  const { user } = useAuth();
  const { client, ongoing, incoming } = useCalls();
  const bridge = useDeviceBridge();
  const location = useLocation();
  const suffix = location.pathname.replace(/^\/settings\/?/, '');
  const section = suffix.startsWith('general/') ? suffix.slice(8) : '';
  const root = suffix === '';
  const general = suffix === 'general';
  const [state, setState] = useState<DeviceState | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [soundAnswer, setSoundAnswer] = useState('');
  const [lostAccess, setLostAccess] = useState<Set<string>>(new Set());
  const [entries, setEntries] = useState<FileRef[]>([]);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [forget, setForget] = useState<FileRef | null>(null);
  const generation = useRef(0);
  const currentState = useRef(state);
  const cancelledWait = useRef<Promise<void>>(Promise.resolve());

  currentState.current = state;

  async function refresh(): Promise<DeviceState | undefined> {
    const epoch = generation.current;
    const next = await bridge.execute({ command: 'device.state.read', args: {} });

    if (epoch !== generation.current) return;

    if (
      currentState.current &&
      (currentState.current.audio.routeName !== next.audio.routeName ||
        (currentState.current.audio.test && !next.audio.test))
    )
      setSoundAnswer('');

    setState((old): DeviceState => (!old || old.revision <= next.revision ? next : old));

    if (section === 'files') {
      const all: FileRef[] = [];
      let cursor: string | null = null;

      do {
        const page: Result<'file.access.list'> = await bridge.execute({
          command: 'file.access.list',
          args: { cursor, limit: 100 },
        });

        all.push(...page.entries);
        cursor = page.nextCursor;
      } while (cursor && epoch === generation.current);

      if (epoch === generation.current) setEntries(all);
    }

    return next;
  }

  useEffect((): (() => void) => {
    const epoch = ++generation.current;
    let cancelled = false;

    setError('');
    setBusy(false);
    setSoundAnswer('');
    setState(null);
    let watching = false;
    const watch = async (): Promise<void> => {
      if (watching || cancelled || document.hidden) return;

      watching = true;
      let cancelledByLifecycle = false;

      try {
        await cancelledWait.current;
        const initial = await refresh();

        if (!initial || cancelled) return;

        let revision = initial.revision;

        while (!cancelled && !document.hidden) {
          const change = await bridge.execute({
            command: 'device.changes.wait',
            args: { afterRevision: revision, timeoutMs: 30000 },
          });

          if (cancelled) return;

          revision = change.revision;

          if (!change.timedOut) await refresh();
        }
      } catch (cause) {
        cancelledByLifecycle = cause instanceof DeviceError && cause.code === 'CANCELLED';

        if (!cancelled && epoch === generation.current && !cancelledByLifecycle)
          setError(deviceErrorMessage(cause));
      } finally {
        watching = false;

        if (cancelledByLifecycle && !cancelled && !document.hidden)
          queueMicrotask((): void => {
            void watch();
          });
      }
    };
    const resume = (): void => {
      if (!document.hidden) {
        void refresh().catch((cause: unknown): void => {
          if (!cancelled) setError(deviceErrorMessage(cause));
        });
        void watch();
      }
    };

    window.addEventListener('focus', resume);
    document.addEventListener('visibilitychange', resume);
    void watch();

    return (): void => {
      cancelled = true;
      generation.current++;
      window.removeEventListener('focus', resume);
      document.removeEventListener('visibilitychange', resume);
      cancelledWait.current = bridge.execute({ command: 'device.changes.cancel', args: {} }).then(
        (): void => {},
        (): void => {},
      );
      const test = currentState.current?.audio.test;

      if (test?.status === 'running')
        void bridge
          .execute({ command: 'audio.test.stop', args: { testId: test.id } })
          .catch((): void => {});
    };
  }, [bridge, location.pathname]);
  useEffect((): void => {
    if (incoming) {
      setConfirmLogout(false);
      setForget(null);
    }
  }, [incoming]);

  async function run<C extends Command>(request: {
    command: C;
    args: Args<C>;
  }): Promise<Result<C> | undefined> {
    const epoch = generation.current;

    setBusy(true);
    setError('');

    try {
      const result = await bridge.execute(request);

      if (epoch === generation.current) await refresh();

      return result;
    } catch (cause) {
      if (
        epoch === generation.current &&
        !(cause instanceof DeviceError && cause.code === 'CANCELLED')
      )
        setError(deviceErrorMessage(cause));
    } finally {
      if (epoch === generation.current) setBusy(false);
    }
  }

  async function verifyAccess(entry: FileRef): Promise<void> {
    const epoch = generation.current;

    setBusy(true);
    setError('');

    try {
      await bridge.execute({ command: 'file.access.restore', args: { id: entry.id } });

      if (epoch === generation.current)
        setLostAccess((old): Set<string> => {
          const next = new Set(old);

          next.delete(entry.id);

          return next;
        });
    } catch (cause) {
      if (epoch === generation.current) {
        setError(deviceErrorMessage(cause));

        if (
          cause instanceof DeviceError &&
          ['ACCESS_LOST', 'NOT_FOUND', 'PERMISSION_DENIED'].includes(cause.code)
        )
          setLostAccess((old): Set<string> => new Set([...old, entry.id]));
      }
    } finally {
      if (epoch === generation.current) setBusy(false);
    }
  }

  if (!user) return <></>;

  if (!root && !general && !Object.hasOwn(titles, section))
    return (
      <section className="settings-page">
        <h1>Настройка не найдена</h1>
        <Link to="/settings/general">К основным настройкам</Link>
      </section>
    );

  const title = root ? 'Настройки' : general ? 'Основные' : titles[section];
  const parent = general ? '/settings' : '/settings/general';
  const status = (key: Resource): string => {
    if (!state) return 'Проверяем…';

    if (key === 'microphone') return permissionLabels[state[key].permission];

    const labels: Record<PermissionState['permission'], string> = {
      granted: 'Разрешена',
      denied: 'Запрещена',
      restricted: 'Ограничена',
      limited: 'Ограничена',
      prompt: 'Не запрошена',
      unknown: 'Неизвестно',
    };

    return labels[state[key].permission];
  };
  const pushLabel = !state
    ? 'Проверяем…'
    : {
        enabled: 'Включены',
        disabled: 'Выключены',
        unavailable: 'Недоступны',
        enabling: 'Включаем…',
        error: 'Ошибка',
      }[state.push.delivery];
  const permission =
    section === 'microphone' || section === 'camera' || section === 'geolocation'
      ? state?.[section]
      : undefined;
  const resource: Resource | null =
    section === 'microphone' || section === 'camera' || section === 'geolocation' ? section : null;
  const test = state?.audio.test;
  const action = (label: string, onClick: () => void, danger = false): JSX.Element => (
    <button
      className={'settings-action' + (danger ? ' settings-danger' : '')}
      disabled={busy}
      onClick={onClick}
    >
      {label}
      {busy && <LoaderCircle className="settings-spinner" size={16} aria-hidden="true" />}
    </button>
  );

  return (
    <section className="settings-page" aria-label={title}>
      <div className="settings-heading">
        {!root && (
          <Link to={parent} aria-label="Назад" className="settings-back">
            <ArrowLeft size={21} />
          </Link>
        )}
        <h1>{title}</h1>
      </div>
      {root ? (
        <>
          <div className="settings-profile">
            <Avatar name={user.display_name} large />
            <h2>{user.display_name}</h2>
            <p>@{user.login}</p>
          </div>
          <Group>
            <Row icon={Settings} color="#8e8e93" title="Основные" to="/settings/general" />
          </Group>
          <Group>{action('Выйти из аккаунта', (): void => setConfirmLogout(true), true)}</Group>
          <p className="settings-note">GChat · Настройки устройства</p>
        </>
      ) : general ? (
        <>
          <Group title="Звук">
            <Row
              icon={Mic}
              color="#ff5b63"
              title="Микрофон"
              value={status('microphone')}
              to="/settings/general/microphone"
            />
            <Row
              icon={Headphones}
              color="#ff9f0a"
              title="Динамики и звук"
              value={state?.audio.routeName ?? 'Системный выход'}
              to="/settings/general/audio"
            />
          </Group>
          <Group title="Уведомления">
            <Row
              icon={Bell}
              color="#ff453a"
              title="Push-уведомления"
              value={pushLabel}
              to="/settings/general/push"
            />
          </Group>
          <Group title="Разрешения устройства">
            <Row
              icon={Camera}
              color="#8e8e93"
              title="Камера"
              value={status('camera')}
              to="/settings/general/camera"
            />
            <Row
              icon={LocateFixed}
              color="#007aff"
              title="Геопозиция"
              value={status('geolocation')}
              to="/settings/general/geolocation"
            />
          </Group>
          <Group title="Файлы">
            <Row
              icon={Folder}
              color="#30b0c7"
              title="Файлы и папки"
              value={
                state
                  ? state.files.retainedCount
                    ? String(state.files.retainedCount)
                    : 'Нет доступов'
                  : 'Проверяем…'
              }
              to="/settings/general/files"
            />
          </Group>
          <p className="settings-note">
            Разрешения действуют на этом устройстве и не зависят от аккаунта. В браузере они
            задаются для сайта.
          </p>
        </>
      ) : (
        <>
          <p className="settings-intro">{descriptions[section]}</p>
          {resource && (
            <>
              <Group>
                <Row
                  icon={ShieldCheck}
                  color="#34c759"
                  title="Доступ"
                  value={permission ? permissionLabels[permission.permission] : 'Проверяем…'}
                />
                {permission &&
                (permission.permission === 'denied' || permission.permission === 'restricted')
                  ? action('Открыть настройки', (): void => {
                      void run({ command: 'device.settings.open', args: {} });
                    })
                  : permission?.permission !== 'granted'
                    ? action('Разрешить доступ', (): void => {
                        void run({ command: 'permission.request', args: { resource } });
                      })
                    : null}
              </Group>
              {permission?.settingsHint === 'siteSettings' &&
                (permission.permission === 'denied' || permission.permission === 'restricted') && (
                  <p className="settings-note">
                    Откройте разрешения сайта в меню браузера. После изменения вернитесь в GChat.
                  </p>
                )}
              {section === 'geolocation' && (
                <p className="settings-note">
                  Точность:{' '}
                  {state?.geolocation.accuracy === 'full'
                    ? 'точная'
                    : state?.geolocation.accuracy === 'reduced'
                      ? 'приблизительная'
                      : 'неизвестна'}
                  .{' '}
                  {state?.geolocation.service === 'disabled'
                    ? 'Геопозиция отключена в системе.'
                    : 'Фоновое отслеживание не используется.'}
                </p>
              )}
              {section === 'microphone' && (
                <Group>
                  {action('Проверить микрофон', (): void => {
                    void run({ command: 'audio.test.start', args: { kind: 'microphone' } });
                  })}
                </Group>
              )}
            </>
          )}
          {section === 'audio' && (
            <>
              <Group>
                <Row
                  icon={Headphones}
                  color="#ff9f0a"
                  title="Аудиовыход"
                  value={state?.audio.routeName ?? 'Системный выход'}
                />
                {action('Выбрать аудиовыход', (): void => {
                  void run({ command: 'audio.output.select', args: {} });
                })}
              </Group>
              <p className="settings-note">
                Если выбор недоступен, используется системный выход. Громкость меняется кнопками
                устройства.
              </p>
              <Group>
                {action('Проверить звук', (): void => {
                  setSoundAnswer('');
                  void run({ command: 'audio.test.start', args: { kind: 'sound' } });
                })}
              </Group>
            </>
          )}
          {(section === 'audio' || section === 'microphone') && (
            <>
              {test?.status === 'running' && (
                <Group>
                  {action('Остановить тест', (): void => {
                    void run({ command: 'audio.test.stop', args: { testId: test.id } });
                  })}
                  <p className="settings-test-status" role="status">
                    {test.kind === 'sound' ? 'Воспроизводим сигнал…' : 'Проверяем микрофон…'}
                  </p>
                </Group>
              )}
              {test?.status === 'failed' && (
                <p role="status" className="settings-note">
                  {deviceErrorMessage(new DeviceError(test.errorCode ?? 'DEVICE_UNAVAILABLE'))}
                </p>
              )}
              {test?.status === 'completed' &&
                test.kind === 'microphone' &&
                section === 'microphone' && (
                  <p className="settings-note" role="status">
                    Микрофон доступен. Проверка завершена.
                  </p>
                )}
              {test?.status === 'completed' && test.kind === 'sound' && section === 'audio' && (
                <Group>
                  <p className="settings-test-status">Вы слышали сигнал?</p>
                  <div className="settings-answers">
                    <button onClick={(): void => setSoundAnswer('Слышимость подтверждена вами.')}>
                      <Check size={17} /> Слышу
                    </button>
                    <button
                      onClick={(): void =>
                        setSoundAnswer('Проверьте громкость устройства и подключённую гарнитуру.')
                      }
                    >
                      <X size={17} /> Не слышу
                    </button>
                  </div>
                </Group>
              )}
              {soundAnswer && (
                <p className="settings-note" role="status">
                  {soundAnswer}
                </p>
              )}
              {ongoing && (
                <p className="settings-note">Проверки доступны после завершения звонка.</p>
              )}
            </>
          )}
          {section === 'push' && (
            <>
              <Group>
                <Row
                  icon={Bell}
                  color="#ff453a"
                  title="Разрешение"
                  value={state ? permissionLabels[state.push.permission] : 'Проверяем…'}
                />
                <Row icon={Volume2} color="#007aff" title="Доставка" value={pushLabel} />
                {state?.push.delivery === 'unavailable'
                  ? action('Открыть настройки', (): void => {
                      void run({ command: 'device.settings.open', args: {} });
                    })
                  : action(
                      state?.push.delivery === 'enabled' ? 'Выключить push' : 'Включить push',
                      (): void => {
                        void run({
                          command:
                            state?.push.delivery === 'enabled' ? 'push.disable' : 'push.enable',
                          args: {},
                        });
                      },
                    )}
              </Group>
              {state?.push.delivery === 'unavailable' && (
                <p className="settings-note">
                  Push для входящих звонков пока недоступен в этой среде или не настроен на сервере.
                  Исходящие звонки от этого не зависят.
                </p>
              )}
            </>
          )}
          {section === 'files' && (
            <>
              <Group>
                {action('Выбрать файл', (): void => {
                  void run({ command: 'file.pick', args: { multiple: true, accept: [] } });
                })}
                {action('Выбрать папку', (): void => {
                  void run({ command: 'directory.pick', args: {} });
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
                  Пока нет выбранных файлов и папок. Вы предоставляете доступ только к тому, что
                  выбрали сами.
                </p>
              )}
            </>
          )}
        </>
      )}
      {error && (
        <div className="settings-error" role="alert">
          <p>{error}</p>
          <button
            disabled={busy}
            onClick={(): void => {
              setError('');
              void refresh().catch((cause: unknown): void => setError(deviceErrorMessage(cause)));
            }}
          >
            Обновить состояние
          </button>
        </div>
      )}
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
                void client
                  .signOut()
                  .catch((cause: unknown): void => setError(deviceErrorMessage(cause)));
              }}
            >
              <LogOut size={17} /> Выйти
            </button>
          </div>
        </Modal>
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
                void run({ command: 'file.access.forget', args: { id: forget.id } });
                setForget(null);
              }}
            >
              Забыть доступ
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
