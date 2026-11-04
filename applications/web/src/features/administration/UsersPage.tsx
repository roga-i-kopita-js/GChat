import type {
  AdminGroupsResponseDto,
  AdminUserDto,
  AdminUserResponseDto,
  AdminUsersResponseDto,
  ApiResult,
} from '@gchat/backend-api';
import { ApiError } from '@gchat/backend-api';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ChevronDown,
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
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';

import { Avatar, Modal } from '../../shared/ui';
import { request } from '../auth/session';
import type { Credentials } from './CredentialsDialog';
import { generatePassword, mutationError } from './policy';

type Action = 'create' | 'password' | 'disable' | 'enable';
type Operation = { action: Action; user?: AdminUserDto };

function readError(cause: unknown): string {
  if (cause instanceof ApiError && cause.status === 403)
    return 'Доступ запрещён. Требуются права администратора.';

  if (cause instanceof ApiError && cause.status === 404) return 'Аккаунт не найден.';

  return 'Не удалось загрузить данные. Проверьте соединение и повторите запрос.';
}

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
  const groups = useQuery({
    queryKey: ['admin', userId, 'group-suggestions', group.trim()],
    queryFn: ({ signal }): Promise<AdminGroupsResponseDto> =>
      request((api): ReturnType<typeof api.adminListGroups> =>
        api.adminListGroups({ query: { q: group.trim(), limit: 20, offset: 0 }, signal }),
      ),
    enabled: action === 'create' && !!group.trim(),
    retry: false,
  });
  const title =
    action === 'create'
      ? 'Создать аккаунт'
      : action === 'password'
        ? 'Сменить пароль'
        : action === 'disable'
          ? 'Отключить аккаунт?'
          : 'Включить аккаунт?';

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    if (sending.current || failed) return;

    sending.current = true;
    setBusy(true);
    setError('');
    const form = new FormData(event.currentTarget);
    const sentPassword = password;

    try {
      let result: AdminUserResponseDto;

      if (action === 'create') {
        const login = String(form.get('login')).trim();

        result = await request((api): Promise<ApiResult<AdminUserResponseDto>> =>
          api.adminCreateUser({
            body: {
              display_name: String(form.get('display_name')).trim(),
              group_name: group.trim(),
              password: sentPassword,
              ...(login ? { login } : {}),
            },
          }),
        );
      } else {
        if (!user) return;

        const path = { user_id: user.id };

        result = await request((api): Promise<ApiResult<AdminUserResponseDto>> =>
          action === 'password'
            ? api.adminChangeUserPassword({ path, body: { password: sentPassword } })
            : action === 'disable'
              ? api.adminDisableUser({ path, body: {} })
              : api.adminEnableUser({ path, body: {} }),
        );
      }

      setPassword('');
      setCopyStatus('');
      complete(
        result.user,
        action === 'create' || action === 'password'
          ? {
              login: result.user.login,
              password: sentPassword,
              self: action === 'password' && result.user.id === userId,
            }
          : undefined,
      );
    } catch (cause) {
      setError(mutationError(cause));

      // A new explicit action is required after an uncertain outcome.
      if (!(cause instanceof ApiError && cause.status >= 400 && cause.status < 500 && cause.code)) {
        setFailed(true);
        setPassword('');
        setCopyStatus('');
      }
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }

  return (
    <Modal
      title={title}
      close={(): void => {
        if (!sending.current) close();
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
        onSubmit={(event): void => {
          void submit(event);
        }}
      >
        <fieldset disabled={busy || failed}>
          {action === 'create' && (
            <>
              <label>
                Имя
                <input name="display_name" required maxLength={80} autoFocus />
              </label>
              <label>
                Группа
                <input
                  value={group}
                  onChange={(event): void => setGroup(event.target.value)}
                  list="admin-groups"
                  required
                  maxLength={80}
                  autoComplete="off"
                />
              </label>
              <datalist id="admin-groups">
                {groups.data?.groups.map((item): JSX.Element => (
                  <option key={item.id} value={item.name} />
                ))}
              </datalist>
              {group.trim() && (
                <p className="admin-hint" role="status">
                  {groups.isError
                    ? 'Подсказки групп недоступны. При создании сервер проверит название.'
                    : groups.isFetching
                      ? 'Ищем группы…'
                      : groups.data?.groups.some(
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
  onCredentials,
  showDetails,
}: {
  userId: string;
  onCredentials: (value: Credentials) => void;
  showDetails: boolean;
}): JSX.Element {
  const cache = useQueryClient();
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
  const q = (params.get('q') ?? '').slice(0, 80);
  const location = useLocation();
  const [searchInput, setSearchInput] = useState(q);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect((): (() => void) => {
    setSearchInput(q);
    clearTimeout(searchTimer.current);

    return (): void => clearTimeout(searchTimer.current);
  }, [q, location.key]);
  const rawStatus = params.get('status');
  const status = rawStatus === 'active' || rawStatus === 'disabled' ? rawStatus : 'all';
  const rawOffset = Number(params.get('offset') ?? 0);
  const offset =
    Number.isSafeInteger(rawOffset) && rawOffset >= 0 && rawOffset <= 2147483647 ? rawOffset : 0;

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
          if (!value || value === 'all' || (key === 'offset' && value === '0')) next.delete(key);
          else next.set(key, value);
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
  const list = useQuery({
    queryKey: ['admin', userId, 'users', q.trim(), status, offset],
    queryFn: ({ signal }): Promise<AdminUsersResponseDto> =>
      request((api): ReturnType<typeof api.adminListUsers> =>
        api.adminListUsers({ query: { q: q.trim(), status, offset, limit: 25 }, signal }),
      ),
    retry: false,
  });
  const detail = useQuery({
    queryKey: ['admin', userId, 'user', selected],
    queryFn: ({ signal }): Promise<AdminUserResponseDto> =>
      request((api): Promise<ApiResult<AdminUserResponseDto>> =>
        api.adminGetUser({ path: { user_id: selected ?? '' }, signal }),
      ),
    enabled: !!selected,
    retry: false,
  });
  const user = detail.data?.user;

  function refresh(): void {
    if (searchInput !== q) {
      changeParams({ q: searchInput, offset: '0' }, true);

      return;
    }

    void cache.invalidateQueries({ queryKey: ['admin', userId] });
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
        <div className="admin-status-filter">
          <select
            aria-label="Состояние аккаунтов"
            value={status}
            onChange={(event): void => {
              const value = event.target.value;

              if (value === 'all' || value === 'active' || value === 'disabled')
                changeParams({ status: value, offset: '0' });
            }}
          >
            <option value="all">Все аккаунты</option>
            <option value="active">Активные</option>
            <option value="disabled">Отключённые</option>
          </select>
          <ChevronDown size={18} aria-hidden="true" />
        </div>
        <button className="secondary" onClick={refresh} disabled={list.isFetching}>
          <RefreshCw size={16} /> Обновить
        </button>
      </div>
      {notice && (
        <p className="admin-notice" role="status">
          {notice}
        </p>
      )}
      <div className="admin-layout">
        <section className="admin-list" aria-label="Список аккаунтов" aria-busy={list.isFetching}>
          {list.isError ? (
            <div className="list-empty" role="alert">
              <p>{readError(list.error)}</p>
              <button
                className="secondary"
                onClick={(): void => {
                  void list.refetch();
                }}
              >
                Повторить
              </button>
            </div>
          ) : list.isPending ? (
            <div className="list-empty" role="status">
              Загружаем аккаунты…
            </div>
          ) : (
            <>
              <div className="admin-list-caption">
                Найдено: {list.data.total} · активность означает доступ к входу
              </div>
              {!list.data.users.length && (
                <div className="list-empty">
                  {q.trim() || status !== 'all'
                    ? 'Нет совпадений'
                    : offset
                      ? 'На этой странице нет аккаунтов'
                      : 'Аккаунтов пока нет'}
                </div>
              )}
              {list.data.users.map((item): JSX.Element => (
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
                  {list.data.users.length
                    ? `${offset + 1}–${Math.min(offset + 25, list.data.total)} из ${list.data.total}`
                    : '0 аккаунтов'}
                </span>
                <button
                  className="icon"
                  aria-label="Предыдущая страница"
                  disabled={!offset || list.isFetching}
                  onClick={(): void => changeParams({ offset: String(Math.max(0, offset - 25)) })}
                >
                  <ChevronLeft size={19} />
                </button>
                <button
                  className="icon"
                  aria-label="Следующая страница"
                  disabled={offset + 25 >= list.data.total || list.isFetching}
                  onClick={(): void => changeParams({ offset: String(offset + 25) })}
                >
                  <ChevronRight size={19} />
                </button>
              </div>
            </>
          )}
        </section>
      </div>
      {selected && !operation && showDetails && (
        <Modal
          title="Карточка аккаунта"
          close={(): void => {
            void navigate('/admin/users' + (params.size ? '?' + params.toString() : ''), {
              replace: true,
            });
          }}
        >
          <div className="admin-detail">
            {detail.isError ? (
              <div className="list-empty" role="alert">
                <p>{readError(detail.error)}</p>
                <button
                  className="secondary"
                  onClick={(): void => {
                    void detail.refetch();
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
                  disabled={detail.isFetching}
                  onClick={(): void => setOperation({ action: 'password', user })}
                >
                  Сменить пароль
                </button>
                <button
                  className={user.status === 'active' ? 'danger-button' : 'primary'}
                  disabled={user.id === userId || detail.isFetching}
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

            cache.setQueryData(['admin', userId, 'user', updated.id], { user: updated });

            if (credentials) onCredentials(credentials);

            if (!credentials?.self) refresh();
          }}
        />
      )}
    </section>
  );
}
