import type { GroupMembersResponseDto, GroupsResponseDto } from '@gchat/backend-api';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  ArrowRight,
  ChevronRight,
  CircleHelp,
  Code2,
  Headphones,
  LogOut,
  Mic,
  MicOff,
  Phone,
  PhoneOff,
  RefreshCw,
  ShieldCheck,
  Users,
  Volume2,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import type { FormEvent, JSX, ReactNode } from 'react';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';

import type { Session } from './auth';
import { errorMessage, identity, login, readSession, request } from './auth';
import { GChatClient } from './client';
import type { Member } from './protocol';
import { reasons } from './protocol';

const client = new GChatClient();

function Avatar({ name, large = false }: { name: string; large?: boolean }): JSX.Element {
  const colors = ['#dceaff', '#e8e2fb', '#dcf2eb', '#faeadc', '#f5e0eb'];
  const index =
    [...name].reduce((sum, char): number => sum + char.charCodeAt(0), 0) % colors.length;

  return (
    <span
      className={'avatar' + (large ? ' large' : '')}
      style={{ background: colors[index] }}
      aria-hidden="true"
    >
      {name
        .trim()
        .split(/\s+/)
        .slice(0, 2)
        .map((word): string => word[0] ?? '')
        .join('')
        .toUpperCase()}
    </span>
  );
}

function Modal({
  title,
  children,
  close,
}: {
  title: string;
  children: ReactNode;
  close: () => void;
}): JSX.Element {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect((): void => {
    ref.current?.showModal();
  }, []);

  return (
    <dialog ref={ref} onCancel={close} className="modal">
      <button className="icon close" aria-label="Закрыть" onClick={close}>
        <X size={20} />
      </button>
      <h2>{title}</h2>
      {children}
    </dialog>
  );
}

function CallSurface({
  incoming,
  children,
}: {
  incoming: boolean;
  children: ReactNode;
}): JSX.Element {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect((): (() => void) | undefined => {
    if (!incoming) return;

    const dialog = ref.current;

    dialog?.showModal();

    return (): void => dialog?.close();
  }, [incoming]);

  return incoming ? (
    createPortal(
      <dialog
        ref={ref}
        className="incoming-call-modal"
        aria-label="Входящий звонок"
        onCancel={(event): void => event.preventDefault()}
      >
        {children}
      </dialog>,
      document.body,
    )
  ) : (
    <>{children}</>
  );
}

function Login({ onSession }: { onSession: () => void }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError('');
    const form = new FormData(event.currentTarget);

    try {
      await login(String(form.get('login')), String(form.get('password')));
      onSession();
    } catch (cause) {
      setError(errorMessage(cause, 'Не удалось войти'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-page">
      <a className="brand" href="/">
        <span className="brand-mark">
          <Phone size={23} fill="currentColor" />
        </span>
        GChat<span className="brand-web">WEB</span>
      </a>
      <div className="login-layout">
        <section className="login-copy">
          <div className="eyebrow">ВАШЕ ПРОСТРАНСТВО ДЛЯ РАЗГОВОРОВ</div>
          <h1>
            Ближе.
            <br />
            <span>Даже на расстоянии.</span>
          </h1>
          <p>
            Люди, с которыми хочется поговорить.
            <br />
            Голосовые звонки в вашем браузере.
          </p>
          <div className="login-art" aria-hidden="true">
            <div className="orbit orbit-one" />
            <div className="orbit orbit-two" />
            <div className="call-symbol">
              <Phone size={48} />
            </div>
            <span className="art-badge">
              <ShieldCheck size={18} /> Только ваши контакты
            </span>
          </div>
        </section>
        <section className="login-card">
          <div className="mini-icon">
            <Headphones size={25} />
          </div>
          <h2>Вход в GChat</h2>
          <p>Рады вас видеть. Войдите в свой аккаунт.</p>
          <form
            onSubmit={(event): void => {
              void client.enableRingtone();
              void submit(event);
            }}
          >
            <label>
              Логин
              <input
                name="login"
                autoComplete="username"
                placeholder="Ваш логин"
                required
                autoFocus
                minLength={3}
              />
            </label>
            <label>
              Пароль
              <input
                name="password"
                type="password"
                autoComplete="current-password"
                placeholder="Ваш пароль"
                required
                minLength={15}
                maxLength={128}
              />
            </label>
            {error && (
              <div role="alert" className="form-error">
                {error}
              </div>
            )}
            <button className="primary" disabled={busy}>
              {busy ? 'Входим…' : 'Войти'}
              <ArrowRight size={18} />
            </button>
          </form>
          <div className="login-note">
            <CircleHelp size={18} />
            <span>
              Данные для входа выдаёт администратор.
              <br />
              Если не получается войти, обратитесь к нему.
            </span>
          </div>
        </section>
      </div>
      <footer>GChat · Голосовые звонки один на один</footer>
    </main>
  );
}

export function App(): JSX.Element {
  const [session, setSession] = useState<Session | null>(readSession);
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const queryClient = useQueryClient();
  const [groupId, setGroupId] = useState<string | null>(null);
  const [person, setPerson] = useState<Member | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [account, setAccount] = useState(false);
  const [diagnostics, setDiagnostics] = useState(false);
  const [names, setNames] = useState<Record<string, string>>({});
  const [now, setNow] = useState(Date.now());
  const [mobile, setMobile] = useState(false);
  const [accountError, setAccountError] = useState('');
  const user = session ? identity(session) : null;
  const groups = useQuery({
    queryKey: ['groups', user?.sub],
    queryFn: async ({ signal }): Promise<GroupsResponseDto> =>
      request((api): ReturnType<typeof api.groupsList> => api.groupsList({ signal })),
    enabled: !!user,
    retry: 1,
    refetchOnWindowFocus: true,
    refetchInterval: 60000,
  });
  const members = useQuery({
    queryKey: ['members', user?.sub, groupId],
    queryFn: async ({ signal }): Promise<GroupMembersResponseDto> => {
      if (!groupId) return { members: [] };

      return request((api): ReturnType<typeof api.groupsListMembers> =>
        api.groupsListMembers({ path: { group_id: groupId }, signal }),
      );
    },
    enabled: !!user && !!groupId,
    retry: 1,
    refetchOnWindowFocus: true,
    refetchInterval: 60000,
  });

  useEffect((): (() => void) => client.start(), []);
  useEffect((): (() => void) => {
    const sync = (): void => {
      const next = readSession();

      setSession(next);

      if (!next) {
        queryClient.clear();
        setGroupId(null);
        setNames({});
        setPerson(null);
        setAccount(false);
      }
    };

    window.addEventListener('gchat-session', sync);
    window.addEventListener('storage', sync);

    return (): void => {
      window.removeEventListener('gchat-session', sync);
      window.removeEventListener('storage', sync);
    };
  }, [queryClient]);
  useEffect((): void => {
    if (groups.data?.groups.length && !groups.data.groups.some((g): boolean => g.id === groupId))
      setGroupId(groups.data.groups[0].id);
  }, [groups.data, groupId]);
  useEffect((): void => {
    if (members.data)
      setNames((previous): Record<string, string> => ({
        ...previous,
        ...Object.fromEntries(
          members.data.members.map((member): [string, string] => [member.id, member.display_name]),
        ),
      }));
  }, [members.data]);
  useEffect((): (() => void) => {
    const timer = setInterval((): void => setNow(Date.now()), 1000);

    return (): void => clearInterval(timer);
  }, []);
  useEffect((): void => {
    if (state.call && state.call.state !== 'ended') {
      setMobile(true);
      setConfirm(false);

      if (state.call.state === 'ringing' && state.call.recipient_id === user?.sub) {
        setAccount(false);
        setDiagnostics(false);
      }
    }
  }, [state.call?.call_id, state.call?.state, user?.sub]);
  // Resolve names in other groups as well, without expanding backend read permissions.
  useEffect((): (() => void) => {
    let cancelled = false;

    if (groups.data)
      void Promise.all(
        groups.data.groups.map(async (group): Promise<void> => {
          try {
            const data = await request((api): ReturnType<typeof api.groupsListMembers> =>
              api.groupsListMembers({ path: { group_id: group.id } }),
            );

            if (!cancelled)
              setNames((old): Record<string, string> => ({
                ...old,
                ...Object.fromEntries(
                  data.members.map((m): [string, string] => [m.id, m.display_name]),
                ),
              }));
          } catch {
            /* Selected group displays its own loading error. */
          }
        }),
      );

    return (): void => {
      cancelled = true;
    };
  }, [groups.data]);

  if (!('locks' in navigator) || !('mediaDevices' in navigator))
    return (
      <main className="unsupported">
        <h1>Откройте GChat в современном браузере</h1>
        <p>
          Для звонков нужны HTTPS, доступ к микрофону и поддержка Web Locks. Локальная разработка
          доступна на localhost.
        </p>
      </main>
    );

  if (!session || !user) return <Login onSession={(): void => setSession(readSession())} />;

  const call = state.call;
  const incoming = !!call && call.recipient_id === user.sub && call.state === 'ringing';
  const peerId = call ? (call.caller_id === user.sub ? call.recipient_id : call.caller_id) : null;
  const peerName = peerId
    ? (names[peerId] ?? (person?.id === peerId ? person.display_name : 'Собеседник'))
    : '';
  const selectedGroup = groups.data?.groups.find((group): boolean => group.id === groupId);
  const currentMembers =
    members.data?.members.filter((member): boolean => member.id !== user.sub) ?? [];
  const ongoing = !!call && call.state !== 'ended';
  const seconds = call?.started_at
    ? Math.max(
        0,
        Math.floor(
          ((call.ended_at ? Date.parse(call.ended_at) : now) - Date.parse(call.started_at)) / 1000,
        ),
      )
    : 0;
  const duration =
    String(Math.floor(seconds / 60)).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0');
  const status =
    call?.state === 'ended'
      ? (reasons[call.end_reason ?? ''] ?? 'Звонок завершён')
      : call?.recovery_id
        ? 'Восстанавливаем соединение…'
        : call?.state === 'active'
          ? 'Разговор'
          : call?.state === 'connecting'
            ? 'Соединяем…'
            : incoming
              ? 'Входящий звонок'
              : 'Вызываем…';
  const enabled = state.owner && state.connection === 'online' && !state.busy;

  function select(member: Member): void {
    if (ongoing) return;

    setPerson(member);
    setMobile(true);
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="/">
          <span className="brand-mark">
            <Phone size={21} fill="currentColor" />
          </span>
          GChat<span className="brand-web">WEB</span>
        </a>
        <div className="workspace-label">ВАШЕ ПРОСТРАНСТВО</div>
        <div className="nav-item active">
          <Users size={19} /> Люди и группы
        </div>
        <div className="sidebar-heading">
          Мои группы<span>{groups.data?.groups.length ?? 0}</span>
        </div>
        <nav aria-label="Группы">
          {groups.isPending && <p className="side-message">Загружаем группы…</p>}
          {groups.data?.groups.map((group): JSX.Element => (
            <button
              key={group.id}
              className={'group-button' + (groupId === group.id ? ' selected' : '')}
              onClick={(): void => {
                setGroupId(group.id);
                setPerson(null);
                setMobile(false);
              }}
            >
              <span className="group-icon">
                <Users size={17} />
              </span>
              <span>{group.name}</span>
              <ChevronRight size={14} />
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="privacy-note">
            <ShieldCheck size={19} />
            <p>
              Ваши контакты.
              <br />
              <strong>Ваши разговоры.</strong>
            </p>
          </div>
          <button className="profile" onClick={(): void => setAccount(true)}>
            <Avatar name={user.display_name} />
            <span>
              <strong>{user.display_name}</strong>
              <small>@{user.login}</small>
            </span>
            <ChevronRight size={16} />
          </button>
        </div>
      </aside>
      <main className="workspace">
        <header className="topbar">
          <div>
            <span className="eyebrow">GCHAT / КОНТАКТЫ</span>
            <h1>Ваши люди</h1>
          </div>
          <span className={'connection ' + state.connection} role="status">
            {state.connection === 'online' ? <Wifi size={15} /> : <WifiOff size={15} />}
            <span>
              {!state.owner
                ? 'Открыто в другой вкладке'
                : state.connection === 'online'
                  ? 'На связи'
                  : state.connection === 'connecting'
                    ? 'Подключаемся…'
                    : 'Нет соединения'}
            </span>
          </span>
        </header>
        {!state.owner && (
          <div className="tab-banner">
            Звонками управляет другая вкладка GChat.
            <button onClick={(): void => client.activate()} disabled={ongoing}>
              Открыть здесь
            </button>
          </div>
        )}
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
        <div className="content-grid">
          <section className={'contact-panel' + (mobile ? ' mobile-hidden' : '')}>
            <div className="panel-title">
              <span className="group-icon">
                <Users size={19} />
              </span>
              <div>
                <h2>{selectedGroup?.name ?? 'Мои контакты'}</h2>
                <p>
                  {currentMembers.length
                    ? `${currentMembers.length} собеседников`
                    : 'Голосовые звонки один на один'}
                </p>
              </div>
            </div>
            {groups.isError || members.isError ? (
              <div className="list-empty">
                <WifiOff size={30} />
                <h3>Не удалось загрузить контакты</h3>
                <p>Проверьте соединение и попробуйте ещё раз.</p>
                <button
                  className="secondary"
                  onClick={(): void => {
                    void groups.refetch();
                    void members.refetch();
                  }}
                >
                  <RefreshCw size={16} /> Повторить
                </button>
              </div>
            ) : groups.isPending || (members.isFetching && !members.data) ? (
              <div className="skeleton-list" aria-label="Загрузка контактов">
                {[0, 1, 2, 3].map((id): JSX.Element => (
                  <div className="skeleton-row" key={id}>
                    <i />
                    <span />
                  </div>
                ))}
              </div>
            ) : !currentMembers.length ? (
              <div className="list-empty">
                <Users size={32} />
                <h3>
                  {groups.data?.groups.length
                    ? 'Здесь пока нет собеседников'
                    : 'У вас пока нет групп'}
                </h3>
                <p>Администратор добавит вас в группу, и её участники появятся здесь.</p>
              </div>
            ) : (
              <div className="contact-list">
                {currentMembers.map((member): JSX.Element => (
                  <div
                    key={member.id}
                    className={
                      'contact-row' +
                      (person?.id === member.id || peerId === member.id ? ' chosen' : '')
                    }
                  >
                    <button
                      className="contact-person"
                      onClick={(): void => select(member)}
                      disabled={ongoing && peerId !== member.id}
                    >
                      <Avatar name={member.display_name} />
                      <span className="contact-name">
                        <strong>{member.display_name}</strong>
                        <small>Голосовой звонок</small>
                      </span>
                    </button>
                    <button
                      className="contact-call"
                      aria-label={`Позвонить: ${member.display_name}`}
                      disabled={!enabled || ongoing}
                      onClick={(): void => {
                        setPerson(member);
                        void client.dial(member.id);
                      }}
                    >
                      <Phone size={18} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="contacts-foot">
              <ShieldCheck size={14} />
              <span>Доступ к группам настраивает администратор</span>
            </div>
          </section>
          <section className={'detail-panel' + (!mobile ? ' mobile-hidden' : '')}>
            {mobile && (
              <button className="mobile-back" onClick={(): void => setMobile(false)}>
                <ArrowLeft size={18} /> Контакты
              </button>
            )}
            {call ? (
              <CallSurface incoming={incoming}>
                <div className={'call-card ' + (call.state === 'ended' ? 'ended' : '')}>
                  <div className="call-brand">
                    <Phone size={16} /> GChat · голосовой звонок
                  </div>
                  <div className="call-person">
                    <Avatar name={peerName} large />
                    <h2>{peerName}</h2>
                    <p role="status" data-testid="call-status">
                      {status}
                    </p>
                    {call.started_at && (
                      <div className="duration" data-testid="duration">
                        {duration}
                      </div>
                    )}
                    {call.state === 'active' && !call.recovery_id && (
                      <div className="sound-wave" aria-hidden="true">
                        {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((id): JSX.Element => (
                          <i key={id} style={{ animationDelay: (id % 4) * 0.15 + 's' }} />
                        ))}
                      </div>
                    )}
                  </div>
                  {!state.selected && call.state !== 'ringing' && call.state !== 'ended' && (
                    <p className="call-hint">Разговор открыт на другом устройстве.</p>
                  )}
                  {state.audioBlocked && (
                    <button
                      className="secondary"
                      onClick={(): void => {
                        void client.playAudio();
                      }}
                    >
                      <Volume2 size={18} /> Включить звук
                    </button>
                  )}
                  {incoming && state.error && <p role="alert">{state.error}</p>}
                  <div className="call-controls">
                    {call.state === 'ended' ? (
                      <button
                        className="secondary"
                        onClick={(): void => {
                          setPerson(null);
                          setMobile(false);
                          client.dismiss();
                        }}
                      >
                        Вернуться к контактам
                        <ArrowRight size={17} />
                      </button>
                    ) : incoming ? (
                      <>
                        <button
                          className="round-action decline"
                          disabled={!enabled}
                          onClick={(): void => {
                            void client.end(true);
                          }}
                        >
                          <span>
                            <PhoneOff size={25} />
                          </span>
                          Отклонить
                        </button>
                        <button
                          className="round-action accept"
                          disabled={!enabled}
                          onClick={(): void => {
                            void client.accept();
                          }}
                        >
                          <span>
                            <Phone size={25} />
                          </span>
                          Принять
                        </button>
                      </>
                    ) : state.selected ? (
                      <>
                        {call.state !== 'ringing' && (
                          <button
                            className={'round-action mute' + (state.muted ? ' muted' : '')}
                            aria-pressed={state.muted}
                            disabled={!state.owner}
                            onClick={(): void => client.mute()}
                          >
                            <span>{state.muted ? <MicOff size={25} /> : <Mic size={25} />}</span>
                            {state.muted ? 'Включить микрофон' : 'Микрофон'}
                          </button>
                        )}
                        <button
                          className="round-action decline"
                          disabled={!enabled}
                          onClick={(): void => {
                            void client.end();
                          }}
                        >
                          <span>
                            <PhoneOff size={25} />
                          </span>
                          {call.state === 'ringing' ? 'Отменить' : 'Завершить'}
                        </button>
                      </>
                    ) : null}
                  </div>
                  <div className="call-bottom">
                    <ShieldCheck size={14} />
                    <span>Аудио передаётся в зашифрованном виде</span>
                  </div>
                </div>
              </CallSurface>
            ) : person ? (
              <div className="person-preview">
                <span className="eyebrow">ГОЛОСОВОЙ ЗВОНОК</span>
                <Avatar name={person.display_name} large />
                <h2>{person.display_name}</h2>
                <p>
                  Хороший разговор начинается
                  <br />с одного звонка.
                </p>
                <button
                  className="primary"
                  disabled={!enabled}
                  onClick={(): void => setConfirm(true)}
                >
                  <Phone size={19} /> Позвонить
                </button>
                <div className="detail-note">
                  <Mic size={15} /> Понадобится доступ к микрофону
                </div>
              </div>
            ) : (
              <div className="welcome-panel">
                <div className="welcome-orbit">
                  <span>
                    <Phone size={38} />
                  </span>
                </div>
                <h2>Есть о чём поговорить</h2>
                <p>
                  Выберите человека из своей группы,
                  <br />
                  чтобы начать голосовой звонок.
                </p>
                <div className="welcome-features">
                  <span>
                    <Headphones size={17} /> Только голос
                  </span>
                  <span>
                    <ShieldCheck size={17} /> Только ваши люди
                  </span>
                </div>
              </div>
            )}
          </section>
        </div>
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
          <button onClick={(): void => setDiagnostics(true)}>
            <Code2 size={14} /> Диагностика
          </button>
        </footer>
      </main>
      {confirm && person && (
        <Modal title="Позвонить?" close={(): void => setConfirm(false)}>
          <div className="confirm-person">
            <Avatar name={person.display_name} />
            <strong>{person.display_name}</strong>
          </div>
          <p>Браузер запросит разрешение на микрофон.</p>
          <div className="modal-actions">
            <button className="secondary" onClick={(): void => setConfirm(false)}>
              Отмена
            </button>
            <button
              className="primary"
              onClick={(): void => {
                setConfirm(false);
                void client.dial(person.id);
              }}
            >
              <Phone size={17} /> Позвонить
            </button>
          </div>
        </Modal>
      )}
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
      {diagnostics && (
        <Modal title="Диагностика соединения" close={(): void => setDiagnostics(false)}>
          <dl className="diagnostics">
            <dt>Соединение</dt>
            <dd>{state.connection}</dd>
            <dt>Вкладка</dt>
            <dd>{state.owner ? 'Основная' : 'Дополнительная'}</dd>
            <dt>Звонок</dt>
            <dd>{call?.call_id ?? '—'}</dd>
            <dt>Состояние / версия</dt>
            <dd>{call ? `${call.state} / ${call.version}` : '—'}</dd>
            <dt>WebRTC</dt>
            <dd>{state.media}</dd>
            <dt>Маршрут</dt>
            <dd data-testid="relay">{state.stats.relay ? 'TURN (relay)' : 'Не выбран'}</dd>
            <dt>Аудио отправлено</dt>
            <dd data-testid="rtp-sent">{state.stats.sent} байт</dd>
            <dt>Аудио получено</dt>
            <dd data-testid="rtp-received">{state.stats.received} байт</dd>
            <dt>Окно восстановления</dt>
            <dd>{call?.recovery_deadline ?? '—'}</dd>
          </dl>
        </Modal>
      )}
    </div>
  );
}
