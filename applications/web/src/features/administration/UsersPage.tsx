import type {
  AdminGroupsResponseDto,
  AdminUserDto,
  AdminUserResponseDto,
} from '@gchat/backend-api';
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  Eye,
  EyeOff,
  Plus,
  RefreshCw,
  Search,
} from 'lucide-react';
import type { FormEvent, JSX } from 'react';
import { useEffect, useId, useRef, useState } from 'react';
import {
  Link,
  Outlet,
  useFetcher,
  useLoaderData,
  useLocation,
  useNavigate,
  useOutletContext,
  useParams,
  useRevalidator,
  useRouteLoaderData,
  useSearchParams,
} from 'react-router';

import { useNavigationProtection } from '../../shared/navigation-protection';
import { Avatar, Modal, Select } from '../../shared/ui';
import type { Credentials } from './CredentialsDialog';
import { generatePassword } from './policy';
import type { AdminData, AdminResult, AdminUsersData } from './routes';

type Action = 'create' | 'password' | 'disable' | 'enable';
type Operation = { action: Action; user?: AdminUserDto };

function AccountOperation({
  operation,
  userId,
  close,
  complete,
}: {
  operation: Operation;
  userId: string;
  close: () => void;
  complete: (user: AdminUserDto, credentials?: Credentials) => void;
}): JSX.Element {
  const { action, user } = operation;
  const [group, setGroup] = useState('');
  const [password, setPassword] = useState((): string =>
    action === 'create' || action === 'password' ? generatePassword() : '',
  );
  const passwordId = useId();
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [copyStatus, setCopyStatus] = useState('');

  async function copyPassword(): Promise<void> {
    try {
      await navigator.clipboard.writeText(password);
      setCopyStatus('Пароль скопирован. Изменения ещё не сохранены.');
    } catch {
      setCopyStatus('Не удалось скопировать. Покажите пароль и скопируйте вручную.');
    }
  }
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const [error, setError] = useState('');
  const [failed, setFailed] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const basePassword = useRef(password);
  const discarded = useRef(false);

  const updateBlocked = useNavigationProtection({
    dirty: (): boolean => {
      if (discarded.current || sending.current || !formRef.current) {
        return false;
      }

      const fields = new FormData(formRef.current);

      return (
        ['display_name', 'login', 'group_name'].some((name): boolean =>
          Boolean(fields.get(name)),
        ) || String(fields.get('password') ?? '') !== basePassword.current
      );
    },
    discard: (): void => {
      discarded.current = true;
      close();
    },
  });
  const groupsFetcher = useFetcher<AdminData<AdminGroupsResponseDto>>();
  const mutation = useFetcher<AdminResult>();
  const handled = useRef<AdminResult | undefined>(undefined);

  useEffect((): void => {
    if (action === 'create' && group.trim()) {
      void groupsFetcher.load('/resources/admin/groups?q=' + encodeURIComponent(group.trim()));
    }
  }, [action, group]);
  useEffect((): void => {
    const result = mutation.data;

    if (mutation.state !== 'idle' || !result || handled.current === result) {
      return;
    }

    handled.current = result;
    sending.current = false;
    setBusy(false);

    if (result.outcome === 'saved') {
      discarded.current = true;
      setPassword('');
      setCopyStatus('');
      complete(result.user);
    } else {
      setError(result.error);

      if (result.outcome === 'unknown') {
        setFailed(true);
        setPassword('');
        setCopyStatus('');
      }
    }
  }, [mutation.data, mutation.state]);
  const groups = groupsFetcher.data?.data;
  const title =
    action === 'create'
      ? 'Создать аккаунт'
      : action === 'password'
        ? 'Сменить пароль'
        : action === 'disable'
          ? 'Отключить аккаунт?'
          : 'Включить аккаунт?';

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();

    if (sending.current || failed || updateBlocked) {
      return;
    }

    sending.current = true;
    setBusy(true);
    setError('');
    const form = new FormData(event.currentTarget);

    form.set('operation', action);

    if (user) {
      form.set('user_id', user.id);
    }

    if (action === 'create' || action === 'password') {
      form.set('password', password);
    }

    if (action === 'create') {
      form.set('group_name', group);
    }

    void mutation.submit(form, { method: 'post', action: '/admin/users' });
  }

  return (
    <Modal
      title={title}
      close={(): void => {
        if (!sending.current) {
          close();
        }
      }}
    >
      {user && (
        <div className="confirm-person">
          <Avatar name={user.display_name} />
          <div>
            <strong>{user.display_name}</strong>
            <p>@{user.login}</p>
          </div>
        </div>
      )}
      <form
        className="admin-form"
        ref={formRef}
        onChange={(): void => {
          discarded.current = false;
        }}
        onSubmit={(event): void => {
          void submit(event);
        }}
      >
        <fieldset disabled={busy || failed || updateBlocked}>
          {action === 'create' && (
            <>
              <label>
                Имя
                <input name="display_name" required maxLength={80} autoFocus />
              </label>
              <label>
                Группа
                <input
                  name="group_name"
                  value={group}
                  onChange={(event): void => setGroup(event.target.value)}
                  list="admin-groups"
                  required
                  maxLength={80}
                  autoComplete="off"
                />
              </label>
              <datalist id="admin-groups">
                {groups?.groups.map((item): JSX.Element => (
                  <option key={item.id} value={item.name} />
                ))}
              </datalist>
              {group.trim() && (
                <p className="admin-hint" role="status">
                  {groupsFetcher.data?.error
                    ? 'Подсказки групп недоступны. При создании сервер проверит название.'
                    : groupsFetcher.state !== 'idle'
                      ? 'Ищем группы…'
                      : groups?.groups.some(
                            (item): boolean =>
                              item.name.toLocaleLowerCase() === group.trim().toLocaleLowerCase(),
                          )
                        ? 'Пользователь будет добавлен в существующую группу.'
                        : 'Если группы с этим названием нет, она будет создана вместе с аккаунтом.'}
                </p>
              )}
              <label>
                Логин · необязательно
                <input
                  name="login"
                  minLength={3}
                  maxLength={32}
                  pattern="[A-Za-z0-9._\-]+"
                  autoComplete="off"
                  placeholder="Сгенерирует сервер"
                />
              </label>
            </>
          )}
          {(action === 'create' || action === 'password') && (
            <>
              <div className="password-control">
                <label htmlFor={passwordId}>Новый пароль</label>
                <div className="password-field">
                  <input
                    id={passwordId}
                    name="password"
                    type={passwordVisible ? 'text' : 'password'}
                    value={password}
                    onChange={(event): void => {
                      setPassword(event.target.value);
                      setCopyStatus('');
                    }}
                    required
                    minLength={15}
                    maxLength={128}
                    autoComplete="new-password"
                  />
                  <div className="password-field-actions">
                    <button
                      type="button"
                      className="password-action"
                      aria-label={passwordVisible ? 'Скрыть пароль' : 'Показать пароль'}
                      title={passwordVisible ? 'Скрыть пароль' : 'Показать пароль'}
                      aria-pressed={passwordVisible}
                      onClick={(): void => setPasswordVisible(!passwordVisible)}
                    >
                      {passwordVisible ? <EyeOff size={18} /> : <Eye size={18} />}
                    </button>
                    <button
                      type="button"
                      className="password-action"
                      aria-label="Скопировать пароль"
                      title="Скопировать пароль"
                      disabled={!password}
                      onClick={(): void => {
                        void copyPassword();
                      }}
                    >
                      <Copy size={18} />
                    </button>
                  </div>
                </div>
                {copyStatus && (
                  <p className="admin-hint" role="status">
                    {copyStatus}
                  </p>
                )}
              </div>
              <button
                type="button"
                className="secondary"
                onClick={(): void => {
                  discarded.current = false;
                  setPassword(generatePassword());
                  setPasswordVisible(false);
                  setCopyStatus('');
                }}
              >
                <RefreshCw size={15} /> Сгенерировать другой
              </button>
              <p className="admin-hint">
                15–128 символов. После успеха пароль появится один раз для передачи пользователю.
              </p>
            </>
          )}
          {action === 'password' && (
            <p>
              Все сессии аккаунта будут завершены. Отключённый аккаунт останется отключённым.
              {user?.id === userId && ' Вам потребуется войти заново.'}
            </p>
          )}
          {action === 'disable' && (
            <p>Вход будет запрещён, все сессии завершены. Логин и группы сохранятся.</p>
          )}
          {action === 'enable' && (
            <p>Аккаунт снова сможет войти с текущим паролем. Старые сессии не восстановятся.</p>
          )}
        </fieldset>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="secondary" disabled={busy} onClick={close}>
            {failed ? 'Закрыть и проверить состояние' : 'Отмена'}
          </button>
          {!failed && (
            <button className={action === 'disable' ? 'danger-button' : 'primary'} disabled={busy}>
              {busy ? 'Выполняем…' : action === 'create' ? 'Создать аккаунт' : 'Подтвердить'}
            </button>
          )}
        </div>
      </form>
    </Modal>
  );
}

export function UsersPage({
  userId,
  sessionId,
  onCredentials,
  showDetails,
}: {
  userId: string;
  sessionId: string;
  onCredentials: (value: Credentials) => void;
  showDetails: boolean;
}): JSX.Element {
  const revalidator = useRevalidator();
  const mounted = useRef(false);

  useEffect((): (() => void) => {
    mounted.current = true;

    return (): void => {
      mounted.current = false;
    };
  }, []);
  const [params, setParams] = useSearchParams();
  const { userId: selected = null } = useParams();
  const navigate = useNavigate();
  const loaded = useRouteLoaderData<AdminUsersData>('admin-users');
  const { q = '', status = 'all', offset = 0 } = loaded?.filters ?? {};
  const location = useLocation();
  const [searchInput, setSearchInput] = useState(q);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect((): (() => void) => {
    setSearchInput(q);
    clearTimeout(searchTimer.current);

    return (): void => clearTimeout(searchTimer.current);
  }, [q, location.key]);

  function changeParams(values: Record<string, string>, replace = false): void {
    clearTimeout(searchTimer.current);
    const changes = {
      ...values,
      ...(searchInput !== q && !('q' in values) ? { q: searchInput, offset: '0' } : {}),
    };

    setParams(
      (previous): URLSearchParams => {
        const next = new URLSearchParams(previous);

        for (const [key, value] of Object.entries(changes)) {
          if (!value || value === 'all' || (key === 'offset' && value === '0')) {
            next.delete(key);
          } else {
            next.set(key, value);
          }
        }

        return next;
      },
      { replace },
    );
  }

  function accountUrl(id: string): string {
    return '/admin/users/' + encodeURIComponent(id) + (params.size ? '?' + params.toString() : '');
  }

  const [operation, setOperation] = useState<Operation | null>(null);
  const [notice, setNotice] = useState('');
  const list = loaded?.sid === sessionId ? loaded.data : null;
  const listError = loaded?.error;
  const loading = revalidator.state === 'loading';

  function refresh(): void {
    if (searchInput !== q) {
      changeParams({ q: searchInput, offset: '0' }, true);

      return;
    }

    void revalidator.revalidate();
  }

  return (
    <section className="admin-workspace" aria-label="Управление аккаунтами">
      <div className="admin-heading">
        <div>
          <h2>Аккаунты</h2>
          <p>Доступ пользователей к GChat</p>
        </div>
        <button
          className="primary"
          onClick={(): void => {
            setNotice('');
            setOperation({ action: 'create' });
          }}
        >
          <Plus size={17} /> Создать аккаунт
        </button>
      </div>
      <div className="admin-toolbar">
        <label className="admin-search">
          <Search size={18} />
          <input
            aria-label="Поиск по имени или логину"
            placeholder="Имя или логин"
            maxLength={80}
            value={searchInput}
            onChange={(event): void => {
              const value = event.target.value;

              setSearchInput(value);
              clearTimeout(searchTimer.current);
              searchTimer.current = setTimeout((): void => {
                changeParams({ q: value, offset: '0' }, true);
              }, 350);
            }}
          />
        </label>
        <Select
          aria-label="Состояние аккаунтов"
          className="admin-status-filter"
          value={status}
          onChange={(value): void => {
            if (value === 'all' || value === 'active' || value === 'disabled') {
              changeParams({ status: value, offset: '0' });
            }
          }}
        >
          <option value="all">Все аккаунты</option>
          <option value="active">Активные</option>
          <option value="disabled">Отключённые</option>
        </Select>
        <button className="secondary" onClick={refresh} disabled={loading}>
          <RefreshCw size={16} /> Обновить
        </button>
      </div>
      {notice && (
        <p className="admin-notice" role="status">
          {notice}
        </p>
      )}
      <div className="admin-layout">
        <section className="admin-list" aria-label="Список аккаунтов" aria-busy={loading}>
          {listError ? (
            <div className="list-empty" role="alert">
              <p>{listError}</p>
              <button
                className="secondary"
                onClick={(): void => {
                  void revalidator.revalidate();
                }}
              >
                Повторить
              </button>
            </div>
          ) : !list ? (
            <div className="list-empty" role="status">
              Загружаем аккаунты…
            </div>
          ) : (
            <>
              <div className="admin-list-caption">
                Найдено: {list.total} · активность означает доступ к входу
              </div>
              {!list.users.length && (
                <div className="list-empty">
                  {q.trim() || status !== 'all'
                    ? 'Нет совпадений'
                    : offset
                      ? 'На этой странице нет аккаунтов'
                      : 'Аккаунтов пока нет'}
                </div>
              )}
              {list.users.map((item): JSX.Element => (
                <Link
                  to={accountUrl(item.id)}
                  className={'admin-row' + (selected === item.id ? ' selected' : '')}
                  key={item.id}
                  onClick={(): void => {
                    setNotice('');
                  }}
                >
                  <Avatar name={item.display_name} />
                  <span className="admin-row-info">
                    <strong>{item.display_name}</strong>
                    <small>
                      @{item.login} · {item.role === 'admin' ? 'Администратор' : 'Пользователь'}
                    </small>
                    <small>
                      {item.groups.map((group): string => group.name).join(', ') || 'Без групп'}
                    </small>
                  </span>
                  <span className={'admin-status ' + item.status}>
                    {item.status === 'active' ? 'Активен' : 'Отключён'}
                  </span>
                  <ChevronRight size={15} />
                </Link>
              ))}
              <div className="admin-pagination">
                <span>
                  {list.users.length
                    ? `${offset + 1}–${Math.min(offset + 25, list.total)} из ${list.total}`
                    : '0 аккаунтов'}
                </span>
                <button
                  className="icon"
                  aria-label="Предыдущая страница"
                  disabled={!offset || loading}
                  onClick={(): void => changeParams({ offset: String(Math.max(0, offset - 25)) })}
                >
                  <ChevronLeft size={19} />
                </button>
                <button
                  className="icon"
                  aria-label="Следующая страница"
                  disabled={offset + 25 >= list.total || loading}
                  onClick={(): void => changeParams({ offset: String(offset + 25) })}
                >
                  <ChevronRight size={19} />
                </button>
              </div>
            </>
          )}
        </section>
      </div>
      <Outlet
        context={
          {
            userId,
            sessionId,
            setOperation,
            showDetails: !operation && showDetails,
          } satisfies UserDetailContext
        }
      />
      {operation && (
        <AccountOperation
          operation={operation}
          userId={userId}
          close={(): void => {
            setOperation(null);
            refresh();
          }}
          complete={(updated, credentials): void => {
            if (mounted.current) {
              setOperation(null);
              void navigate(accountUrl(updated.id));
              setNotice('Операция выполнена. Данные аккаунта обновлены.');
            }

            if (credentials) {
              onCredentials(credentials);
            }

            if (!credentials?.self) {
              refresh();
            }
          }}
        />
      )}
    </section>
  );
}

interface UserDetailContext {
  userId: string;
  sessionId: string;
  setOperation(operation: Operation): void;
  showDetails: boolean;
}

export function UserDetailRoute(): JSX.Element {
  const { userId, sessionId, setOperation, showDetails } = useOutletContext<UserDetailContext>();
  const detail = useLoaderData<AdminData<AdminUserResponseDto>>();
  const user = detail?.sid === sessionId ? detail.data?.user : null;
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const loading = revalidator.state === 'loading';

  return (
    <>
      {showDetails && (
        <Modal
          title="Карточка аккаунта"
          close={(): void => {
            void navigate('/admin/users' + (params.size ? '?' + params.toString() : ''), {
              replace: true,
            });
          }}
        >
          <div className="admin-detail">
            {detail?.error ? (
              <div className="list-empty" role="alert">
                <p>{detail.error}</p>
                <button
                  className="secondary"
                  onClick={(): void => {
                    void revalidator.revalidate();
                  }}
                >
                  Повторить
                </button>
              </div>
            ) : !user ? (
              <div className="list-empty" role="status">
                Загружаем карточку…
              </div>
            ) : (
              <>
                <Avatar name={user.display_name} large />
                <h2>{user.display_name}</h2>
                <p>@{user.login}</p>
                <span className={'admin-status ' + user.status}>
                  {user.status === 'active' ? 'Активен' : 'Отключён'}
                </span>
                <dl className="admin-facts">
                  <dt>Роль</dt>
                  <dd>
                    {user.role === 'admin' ? 'Администратор' : 'Пользователь'}
                    {user.id === userId ? ' · это вы' : ''}
                  </dd>
                  <dt>Группы</dt>
                  <dd>
                    {user.groups.map((group): string => group.name).join(', ') || 'Без групп'}
                  </dd>
                  <dt>Создан</dt>
                  <dd>{new Date(user.created_at).toLocaleString('ru')}</dd>
                  {user.disabled_at && (
                    <>
                      <dt>Отключён</dt>
                      <dd>{new Date(user.disabled_at).toLocaleString('ru')}</dd>
                    </>
                  )}
                </dl>
                <button
                  className="secondary"
                  disabled={loading}
                  onClick={(): void => setOperation({ action: 'password', user })}
                >
                  Сменить пароль
                </button>
                <button
                  className={user.status === 'active' ? 'danger-button' : 'primary'}
                  disabled={user.id === userId || loading}
                  onClick={(): void =>
                    setOperation({ action: user.status === 'active' ? 'disable' : 'enable', user })
                  }
                >
                  {user.status === 'active' ? 'Отключить аккаунт' : 'Включить аккаунт'}
                </button>
                {user.id === userId && (
                  <p className="admin-hint">Собственный аккаунт отключить нельзя.</p>
                )}
              </>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}
