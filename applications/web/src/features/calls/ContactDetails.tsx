import { MessageCircle, Mic, Phone } from 'lucide-react';
import type { JSX } from 'react';
import { useState } from 'react';

import { useDevice } from '../../shared/device/react';
import { Avatar, Modal } from '../../shared/ui';
import { useCalls } from './CallsProvider';

export function ContactDetails({
  dial,
  write,
  canWrite,
}: {
  dial(peer: string): Promise<void>;
  write(peer: string): void;
  canWrite: boolean;
}): JSX.Element | null {
  const device = useDevice();
  const { person, enabled } = useCalls();
  const [confirm, setConfirm] = useState(false);

  if (!person) {
    return null;
  }

  return (
    <>
      <div className="person-preview">
        <span className="eyebrow">ГОЛОСОВОЙ ЗВОНОК</span>
        <Avatar name={person.display_name} large />
        <h2>{person.display_name}</h2>
        <p>
          Хороший разговор начинается
          <br />с одного звонка.
        </p>
        <div className="person-actions">
          <button className="primary" disabled={!enabled} onClick={(): void => setConfirm(true)}>
            <Phone size={19} /> Позвонить
          </button>
          <button className="secondary" disabled={!canWrite} onClick={(): void => write(person.id)}>
            <MessageCircle size={19} /> Написать сообщение
          </button>
        </div>
        <div className="detail-note">
          <Mic size={15} /> Понадобится доступ к микрофону
        </div>
      </div>
      {confirm && person && (
        <Modal title="Позвонить?" close={(): void => setConfirm(false)}>
          <div className="confirm-person">
            <Avatar name={person.display_name} />
            <strong>{person.display_name}</strong>
          </div>
          <p>Для звонка понадобится доступ к микрофону.</p>
          <div className="modal-actions">
            <button className="secondary" onClick={(): void => setConfirm(false)}>
              Отмена
            </button>
            <button
              className="primary"
              onClick={(): void => {
                setConfirm(false);
                void dial(person.id);
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
