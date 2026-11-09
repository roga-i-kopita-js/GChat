import {
  ArrowLeft,
  Headphones,
  MessageCircle,
  Phone,
  RefreshCw,
  ShieldCheck,
  Users,
  WifiOff,
} from 'lucide-react';
import type { JSX } from 'react';
import { lazy, useEffect, useRef, useState } from 'react';
import { useLoaderData, useNavigate, useRevalidator, useSearchParams } from 'react-router';

import type { Member } from '../../shared/calls/protocol';
import { deviceErrorMessage } from '../../shared/device/messages';
import { useDevice, useDevicePresentation } from '../../shared/device/react';
import { useBootstrap } from '../../shared/dialogs/context';
import { dialogError } from '../../shared/dialogs/runtime';
import { Button, Select, Skeleton } from '../../shared/ui';
import { LazyPanel } from '../../shared/ui/LazyPanel';
import { useAuth } from '../auth/AuthProvider';
import { UserCard } from '../users/UserCard';
import { CallCardSlot } from './CallCardSlot';
import { useCalls } from './CallsProvider';
import type { ContactsData } from './contacts';

const ContactDetails = lazy(
  async (): Promise<{ default: typeof import('./ContactDetails').ContactDetails }> => {
    const { ContactDetails: resultContactDetails } = await import('./ContactDetails');

    return {
      default: resultContactDetails,
    };
  },
);

export function CallsPage(): JSX.Element {
  const device = useDevice();
  const presentation = useDevicePresentation();
  const { user } = useAuth();
  const { runtime: dialogs } = useBootstrap();
  const navigate = useNavigate();
  const { mobile, setMobile, person, setPerson, ongoing, enabled, peerId, call, incoming } =
    useCalls();
  const contacts = useLoaderData<ContactsData>();
  const revalidator = useRevalidator();
  const [, setParams] = useSearchParams();
  const groupId = contacts.groupId;
  const groups = contacts.sid === user?.sid ? contacts.groups : [];
  const currentMembers =
    contacts.sid === user?.sid
      ? contacts.members.filter((member): boolean => member.id !== user?.sub)
      : [];
  const setGroupId = (id: string | null): void => {
    setParams(id ? { group: id } : {});
  };
  const [prepareError, setPrepareError] = useState('');
  const [preparing, setPreparing] = useState(false);
  const attempt = useRef(0);
  const preparingRef = useRef(false);

  useEffect((): void => {
    attempt.current++;
  }, []);

  async function dial(peer: string): Promise<void> {
    if (preparingRef.current) {
      return;
    }

    preparingRef.current = true;
    const id = ++attempt.current;

    setPreparing(true);
    setPrepareError('');

    try {
      if (id === attempt.current) {
        await device.calls.dial(peer);
      }
    } catch (error) {
      if (id === attempt.current) {
        setPrepareError(deviceErrorMessage(error));
      }
    } finally {
      preparingRef.current = false;

      if (id === attempt.current) {
        setPreparing(false);
      }
    }
  }

  function write(peer: string): void {
    if (!dialogs) {
      return;
    }

    setPrepareError('');
    void (async () => {
      try {
        const id = await dialogs.openPeer(peer);

        void navigate('/dialogs/' + id);
      } catch (cause) {
        return setPrepareError(dialogError(cause));
      }
    })();
  }

  function select(member: Member): void {
    if (ongoing) {
      return;
    }

    setPerson(member);
    setMobile(true);
  }

  if (!user) {
    return <></>;
  }

  let contactsContent;

  if (contacts.error) {
    contactsContent = (
      <div className="list-empty">
        <WifiOff size={30} />
        <h3>Не удалось загрузить контакты</h3>
        <p>Проверьте соединение и попробуйте ещё раз.</p>
        <Button
          variant="secondary"
          onClick={(): void => {
            void revalidator.revalidate();
          }}
        >
          <RefreshCw size={16} /> Повторить
        </Button>
      </div>
    );
  } else if (
    contacts.sid !== user.sid ||
    (revalidator.state === 'loading' && !currentMembers.length)
  ) {
    contactsContent = (
      <div className="skeleton-list" role="status" aria-label="Загрузка контактов">
        {[0, 1, 2, 3].map((id): JSX.Element => (
          <div className="skeleton-row" key={id}>
            <Skeleton variant="circular" width="var(--ui-control-height)" />
            <div className="skeleton-copy">
              <Skeleton width="65%" />
              <Skeleton width="40%" height="var(--ui-font-caption)" />
            </div>
          </div>
        ))}
      </div>
    );
  } else if (!currentMembers.length) {
    contactsContent = (
      <div className="list-empty">
        <Users size={32} />
        <h3>
          {user.role === 'admin' || groups.length
            ? 'Здесь пока нет собеседников'
            : 'У вас пока нет групп'}
        </h3>
        <p>
          {user.role === 'admin'
            ? 'Активные пользователи появятся здесь после создания аккаунтов.'
            : 'Администратор добавит вас в группу, и её участники появятся здесь.'}
        </p>
      </div>
    );
  } else {
    contactsContent = (
      <div className="contact-list">
        {currentMembers.map((member): JSX.Element => (
          <div
            key={member.id}
            className={
              'contact-row' + (person?.id === member.id || peerId === member.id ? ' chosen' : '')
            }
          >
            <button
              className="contact-person"
              onClick={(): void => select(member)}
              disabled={ongoing && peerId !== member.id}
            >
              <UserCard
                userId={member.id}
                displayName={member.display_name}
                subtitle="Голосовой звонок"
              />
            </button>
            <Button
              variant="ghost"
              size="icon"
              className="contact-call"
              aria-label={`Написать: ${member.display_name}`}
              disabled={!dialogs}
              onClick={(): void => write(member.id)}
            >
              <MessageCircle size={18} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="contact-call"
              aria-label={`Позвонить: ${member.display_name}`}
              disabled={!enabled || ongoing || preparing}
              onClick={(): void => {
                setPerson(member);
                void dial(member.id);
              }}
            >
              <Phone size={18} />
            </Button>
          </div>
        ))}
      </div>
    );
  }

  let detailPanel;

  if (call) {
    detailPanel = (presentation.callControls === 'host' || !incoming) && <CallCardSlot />;
  } else if (person) {
    detailPanel = (
      <LazyPanel
        key={person.id}
        pending={<p role="status">Загружаем карточку…</p>}
        failed={
          <p role="alert">
            Не удалось загрузить карточку собеседника. Быстрый звонок доступен в списке контактов.
          </p>
        }
      >
        <ContactDetails dial={dial} write={write} canWrite={!!dialogs} />
      </LazyPanel>
    );
  } else {
    detailPanel = (
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
    );
  }

  return (
    <>
      {prepareError && (
        <p role="alert" className="error-banner">
          {prepareError}
        </p>
      )}
      <div className="content-grid">
        <section className={'contact-panel' + (mobile ? ' mobile-hidden' : '')}>
          {(groups.length > 1 || user.role === 'admin') && (
            <div className="contact-controls">
              <Select
                aria-label="Группа контактов"
                className="contacts-group-select"
                value={groupId ?? ''}
                onChange={(value): void => {
                  setGroupId(value || null);
                  setPerson(null);
                  setMobile(false);
                }}
              >
                {user.role === 'admin' && <option value="">Все пользователи</option>}
                {groups.map((group): JSX.Element => (
                  <option key={group.id} value={group.id}>
                    {group.name}
                  </option>
                ))}
              </Select>
            </div>
          )}
          {contactsContent}
        </section>
        <section className={'detail-panel' + (!mobile ? ' mobile-hidden' : '')}>
          {mobile && (
            <button className="mobile-back" onClick={(): void => setMobile(false)}>
              <ArrowLeft size={18} /> Контакты
            </button>
          )}
          {detailPanel}
        </section>
      </div>
    </>
  );
}
