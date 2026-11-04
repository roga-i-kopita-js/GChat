import {
  ArrowLeft,
  Headphones,
  Mic,
  Phone,
  RefreshCw,
  ShieldCheck,
  Users,
  WifiOff,
} from 'lucide-react';
import type { JSX } from 'react';
import { useEffect, useState } from 'react';

import { Avatar, Modal, Select } from '../../shared/ui';
import { useAuth } from '../auth/AuthProvider';
import { CallCard } from './CallCard';
import { useCalls } from './CallsProvider';
import type { Member } from './protocol';

export function CallsPage(): JSX.Element {
  const { user } = useAuth();
  const {
    client,
    groups,
    groupId,
    setGroupId,
    members,
    selectedGroup,
    currentMembers,
    mobile,
    setMobile,
    person,
    setPerson,
    ongoing,
    enabled,
    peerId,
    call,
    incoming,
  } = useCalls();
  const [confirm, setConfirm] = useState(false);

  useEffect((): void => {
    if (call && call.state !== 'ended') setConfirm(false);
  }, [call?.call_id, call?.state]);
  function select(member: Member): void {
    if (ongoing) return;

    setPerson(member);
    setMobile(true);
  }

  if (!user) return <></>;

  return (
    <>
      <div className="content-grid">
        <section className={'contact-panel' + (mobile ? ' mobile-hidden' : '')}>
          <div className="panel-title">
            <span className="group-icon">
              <Users size={19} />
            </span>
            <div>
              {groups.data && groups.data.groups.length > 1 ? (
                <Select
                  aria-label="Группа контактов"
                  className="contacts-group-select"
                  value={groupId ?? ''}
                  onChange={(value): void => {
                    setGroupId(value);
                    setPerson(null);
                    setMobile(false);
                  }}
                >
                  {groups.data.groups.map((group): JSX.Element => (
                    <option key={group.id} value={group.id}>
                      {group.name}
                    </option>
                  ))}
                </select>
              ) : (
                <h2>{selectedGroup?.name ?? 'Мои контакты'}</h2>
              )}
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
            !incoming && <CallCard />
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
    </>
  );
}
