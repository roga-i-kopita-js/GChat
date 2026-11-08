---
doc_type: client
decision_status: accepted
implementation_status: absent
source: null
planned_source: applications/web/src/app/
tests: []
---

# Поток данных и маршрутизация Web

Целевой контракт перехода на React Router Data mode с `createBrowserRouter`, RouterProvider, клиентскими `loader`/`action` и сохранением Vite. TanStack Query удаляется после миграции последнего потребителя. Framework mode, SSR, файловая генерация маршрутов и второй кеш серверных данных не вводятся. Пользователь поручил самостоятельно закрыть детали, выбирая простую и качественную реализацию.

Это требуемое поведение, а не описание готового кода. Сейчас приложение использует BrowserRouter и Query. [D007](../architecture/decisions/D007-web-routing.md) фиксирует целевое решение; границы платформы, HTTP, native-навигации и фабрики принадлежат [API device](device-api.md). Статус accepted разрешает последующую реализацию, но этот этап меняет документацию.

## Направление данных

```text
URL → loader → сервис → device.http/storage → mapping → loaderData → компонент
Форма → action → сервис → сохранение → revalidation → loaderData
Именованное событие runtime → неизменяемая актуальная модель → React
```

Loader нормализует params/query, проверяет контекст и права, обращается к сервису и возвращает модель страницы. Mapping — чистая функция. Сервис владеет бизнес-операцией; компонент отображает loaderData без копирования результата в useState. Зависимости передаются через `createRoutes(device)`, без React hooks и глобального SDK внутри loader.

HTTP-клиент — `device.http` с интерфейсом переданного generated API-класса. Защищённый сервис использует `device.session.run((http, signal) => http.method({signal, ...args}))`; сигнал Router объединяется с сигналом сессии. Native выполняет HTTP своим сетевым стеком по [контракту транспорта](device-api.md#http-и-подмена-транспорта). Фича не выбирает платформу и не создаёт отдельный SDK.

Action валидирует ввод и вызывает один сервис изменения. Form/fetcher и состояния Router отражают отправку. Успех запускает штатную ревалидацию matched loaders; shouldRevalidate отключает её только для маршрутов, не владеющих изменёнными данными, например descriptor диалога. Специальный API ручной инвалидации кеша не вводится. Такое разделение соответствует [Data mode](https://reactrouter.com/start/data/data-loading) и [actions](https://reactrouter.com/start/data/actions).

## Модели маршрутов

DTO переиспользуются из generated SDK, без ручных схем HTTP. ScopeKey — безопасный идентификатор текущего server/account/session-generation, без токена; при его смене старые данные и формы удаляются из UI.

```ts
import type { AdminUserDto, GroupDto, GroupMemberDto } from '@gchat/backend-api';

export interface CallsPageData {
  scopeKey: string;
  group: { kind: 'group'; id: string } | { kind: 'all' } | null;
  groups: GroupDto[];
  contacts: GroupMemberDto[];
}

export interface AdminUsersPageData {
  scopeKey: string;
  filters: { q: string; status: 'all' | 'active' | 'disabled'; offset: number };
  users: AdminUserDto[];
  total: number;
}

export interface AdminUserPageData {
  scopeKey: string;
  user: AdminUserDto;
}

export interface DialogsPageData {
  scopeKey: string;
  dialogId: string | null;
}

export type SettingsSection = 'microphone' | 'audio' | 'push' | 'camera' | 'geolocation' | 'files';
export interface SettingsPageData {
  section: SettingsSection;
}
export interface LoginPageData {
  serverUrl: string;
  returnTo: string;
}

export type FormResult<T> =
  | { outcome: 'saved'; value: T }
  | { outcome: 'invalid'; fields: Record<string, string> }
  | { outcome: 'failed'; message: string }
  | { outcome: 'unknown'; message: string };
```

| Маршрут                           | Loader и модель                                                                                                                                                        | Разрешённые query                                                                                          |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `/`                               | Redirect с replace на `/calls`                                                                                                                                         | Нет                                                                                                        |
| `/login`                          | LoginPageData. ServerUrl — выбранный доверенный origin. ReturnTo — проверенный внутренний адрес, по умолчанию `/calls`; после входа переход с replace                  | `serverUrl` только текущий origin, `returnTo` только допустимый внутренний маршрут без секретов            |
| `/calls`                          | CallsPageData. Группы и участники читаются через сервис контактов; для admin режим all читает все страницы активных пользователей. Маппинг даёт только id/display_name | `group`: доступный UUID группы либо `all` только для admin; отсутствующий означает первую доступную группу |
| `/admin`                          | Redirect с replace на `/admin/users`                                                                                                                                   | Нет                                                                                                        |
| `/admin/users`                    | AdminUsersPageData, страницы по 25. Все фильтры и пагинация принадлежат URL                                                                                            | `q`: trim, до 80 символов; `status`: all/active/disabled; `offset`: безопасное целое ≥0, кратное 25        |
| `/admin/users/:userId`            | Родительский список и AdminUserPageData дочерней карточки; отсутствие/отказ — errorElement, не пустая успешная карточка                                                | Те же q/status/offset, чтобы сохранить контекст списка                                                     |
| `/dialogs` и `/dialogs/:dialogId` | DialogsPageData. Loader обеспечивает готовность локального scope и выбранной переписки; живые данные принадлежат DialogRuntime                                         | Нет                                                                                                        |
| `/settings`, `/settings/general`  | Redirect с replace на `/settings/general/microphone`                                                                                                                   | Нет                                                                                                        |
| `/settings/general/:section`      | SettingsPageData; section из union выше. Начальное чтение и изменения устройства приходят из сервисов device                                                           | Нет                                                                                                        |

Web-loader канонизирует некорректные необязательные фильтры к значениям по умолчанию с replace. Невалидный path id даёт 404 до HTTP. Native использует тот же normalizer, но отклоняет неизвестные параметры/невалидные значения вместо незаметной смены цели. Hash в native-командах запрещён. Query `returnTo` не принимает origin, `//`, вложенный login/returnTo, токены и пароли. Служебный query Router для index action не принимается как native-цель.

Защита проверяется в каждом protected loader/action до чтения данных: matched loaders могут выполняться параллельно. Родительского RequireSession недостаточно. Административный loader проверяет роль до admin-запроса; backend guards сохраняются. При anonymous loader перенаправляет на login с проверенным returnTo, при истечении текущей сессии старые loaderData немедленно скрываются. Loader на каждой операции передаёт request.signal; поздний ответ старого scopeKey не публикуется.

## Владение состоянием

| Данные                                       | Владелец                     | Правило                                                         |
| -------------------------------------------- | ---------------------------- | --------------------------------------------------------------- |
| Поиск, фильтр, страница, адресуемая сущность | URL                          | Временный ввод до применения фильтра допустим локально          |
| Контакты, список и карточка admin            | Router loaderData            | Нет параллельного Query-кеша или копии данных в state           |
| Производные поля                             | Mapping/чистый selector      | Не синхронизируются useEffect                                   |
| Форма до сохранения                          | Один черновик формы          | База сохранённой записи отделена от локальных изменений         |
| Меню, видимость пароля, подтверждение        | Локальный UI state           | Не становится сохранённой серверной сущностью                   |
| Сессия, звонок, соединение, устройство       | Профильный runtime за device | Живёт выше страниц, предоставляет типизированные enum-события   |
| История, outbox, постоянный черновик диалога | DialogRuntime/storage        | Сохраняются scope/CAS/epoch и согласование вкладок по Bootstrap |

Контакты не копируются в состояние звонкового движка. Текущее имя собеседника — selector по странице/справочнику, имя вне загруженной страницы разрешает сервис контактов с дедупликацией одновременного чтения в рамках одной загрузки. Постоянный кеш контактов и имён не вводится; временный справочник долгоживущего UI очищается при смене scope и заменяется целиком актуальной моделью, без второго владельца серверных сущностей.

## Живые модели диалогов

Диалог не поддерживается одновременно изменяемыми копиями в loaderData и runtime. Loader возвращает descriptor; доступная локальная история показывается сразу, сетевое обновление выполняет runtime. Ошибка сети не блокирует чтение локальной истории. Новая переписка без локальных данных показывает явное состояние загрузки/ошибки.

Runtime предоставляет `listModel()` и `conversationModel(dialogId)` — стабильные источники с getState и on(enum, handler). Снимки неизменяемые, кешируются по storage revision после commit и не перечитываются из IndexedDB/SQLite при каждом React-render. Существующий getSnapshot только со служебным статусом расширяется адаптером модели; Query-инвалидация больше не нужна.

```ts
import type { DialogDto } from '@gchat/backend-api';
import type { DialogView } from '../../shared/dialogs/runtime';

export enum DialogModelEvent {
  ListChanged = 'listChanged',
  ConversationChanged = 'conversationChanged',
}
export interface DialogListState {
  revision: number;
  status: 'starting' | 'ready' | 'error';
  items: readonly DialogDto[];
  hasMore: boolean;
  error: string | null;
  storageWarning: string | null;
}
export interface DialogConversationState {
  revision: number;
  dialogId: string;
  status: 'starting' | 'ready' | 'error';
  view: Readonly<DialogView> | null;
  error: string | null;
}
export interface DialogModel<T, E extends DialogModelEvent> {
  getState(): Promise<T>;
  on(event: E, handler: (state: T) => void): () => void;
}
export interface DialogModels {
  listModel(): DialogModel<DialogListState, DialogModelEvent.ListChanged>;
  conversationModel(
    id: string,
  ): DialogModel<DialogConversationState, DialogModelEvent.ConversationChanged>;
}
```

Снимок view включает уже определённые record/messages/outbox/draft/syncing; новая серверная схема не создаётся. Адаптер перечитывает только изменившийся диалог после storage commit и отбрасывает результат меньшей revision/старого scope. Событие метаданных/непрочитанности обновляет список; сообщение, outbox и черновик — выбранную conversationModel и затронутую строку списка. Служебный статус не вызывает полную ревалидацию всех маршрутов. Пагинация/older остаются у runtime; loader не становится вторым владельцем соединения или истории. Модели не накапливают всю историю: conversation-кеш освобождается после последней подписки и завершения связанных операций; сохранённые данные остаются в storage. Новый scope создаёт новые источники, старые ответы не публикуются.

## Формы, конфликты и неизвестный результат

Черновик административной формы инициализируется при открытии сущности и хранит baseSnapshot, values и dirty. При чистой форме новая loader-модель заменяет базу. При dirty новая модель не затирает values: если изменились редактируемые поля базы, UI предлагает загрузить новые значения или оставить ввод. Серверного compare-and-swap, которого нет в API, клиент не обещает. При смене userId создаётся новый черновик после прохождения blocker. Пароль живёт только в памяти формы, без URL, loaderData или постоянного storage.

Actions создания, смены пароля и доступа возвращают FormResult. Saved отражается через ревалидацию; failed/invalid/unknown сохраняют ввод. Повторная отправка блокируется на время операции. Сеть, некорректный успешный ответ и 5xx не дают основания повторить изменение; unknown требует сверить актуальные данные и нового явного нажатия. Чтение карточки не подтверждает установку конкретного пароля. Однократный показ выданных credentials сохраняет действующий контракт, включая собственный сброс пароля и скрытие при background.

Диалоговый черновик сохраняется через существующий CAS runtime, без второй React-копии сохранённого текста. Локальный буфер печати имеет revision базы, сохраняется по существующим правилам и сбрасывается только после подтверждённого commit. Перед уходом flush завершается, затем навигация продолжается. Ошибка flush блокирует уход и предлагает повтор либо явный отказ от несохранённого ввода; обязательная инвалидация сессии сохраняет правила Bootstrap и не продолжает запросы старого namespace.

Один blocker в app-root объединяет dirty-состояние форм. Он охватывает Link, Browser Back/Forward, программную и native-навигацию через общий Router; используется [useBlocker](https://reactrouter.com/api/hooks/useBlocker). Подтверждение не дублируется отдельным native-dialog. При жёсткой перезагрузке применяется beforeunload: гарантии записи после закрытия вкладки не обещаются. Смена подтверждённо недействительной сессии обходит blocker и удаляет обычные пользовательские данные из UI.

## Композиция и переход

Bootstrap создаёт device и передаёт createRoutes/normalizer через его публичную фабрику. Навигационный адаптер создаёт один router вне React state и владеет им; DeviceProvider монтирует RouterProvider. Прямого вызова реализации router из bootstrap/native-подписки нет. Сервисы сессии, Calls и DialogRuntime живут выше страниц и не пересоздаются при смене URL.

Операции с user activation — микрофон перед звонком, разрешения, выбор файлов/выхода, разблокировка звука — вызываются из обработчика жеста напрямую через device. Их не переносят в отложенный action, который потеряет жест. Обычные сохранения admin-форм принадлежат actions; отправка/черновики диалога — существующему runtime/outbox.

Порядок миграции:

1. Собрать device и router, передать зависимости существующим сервисам, сохранить один WSS и владельца медиа.
2. Перенести контакты и admin-списки/карточки в loaders, административные сохранения в actions; удалить их query hooks и синхронизирующие эффекты.
3. Подключить живые модели Calls/Dialogs/Device и единый blocker. Удалить Query-инвалидации диалогов и копии контактов в CallsProvider.
4. После последнего потребителя удалить QueryClientProvider, query helpers и зависимость TanStack Query. Промежуточный этап не объявляется завершённой миграцией.

## Критерии приёмки

- Прямой URL, Web/native-переход и история дают одну модель страницы. Сохраняются basename, SPA fallback, доступы и форма адреса из Web-контракта.
- Protected loaders/actions независимо проверяют готовую сессию/роль; отменённые и старые scope не публикуют данные. Токены не попадают в URL/loaderData/history.
- У сохранённой сущности один владелец. Нет Query-кеша поверх loaderData или DialogRuntime, нет копирования loaderData в отображающий state.
- Saved ревалидирует затронутые данные; dirty-форма не теряет ввод при фоновом обновлении. Unknown не повторяет изменение автоматически.
- Диалоги обновляются из commit-событий без повторного чтения storage на каждый render и ревалидации всего router. Сохраняются локальная история, CAS, outbox, порядок и ограничения отправок Bootstrap.
- Link/POP/native одинаково защищают несохранённый ввод. Инвалидация сессии скрывает старые данные и не блокируется формой.
- Смена страницы не останавливает WSS, выбранный звонок и удерживаемую им камеру; не появляется второй runtime/refresh/capture.
- User activation и межвкладочная координация сохраняются. Завершение миграции проверяется отсутствием query hooks/provider/зависимости.
- Для реализации выполняются Web typecheck/build и относящиеся unit/маршрутные E2E. Физические аудио/iOS/PiP/push проверки учитываются отдельно. Для документации — `pnpm docs:check` и проверка TypeScript-примеров.

Открытых архитектурных решений в объёме этого документа нет. Расширение backend API, новые продуктовые функции и платформенная приёмка ведутся у профильных владельцев и не считаются выполненными этой спецификацией.
