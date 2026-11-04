import { Copy } from 'lucide-react';
import type { JSX } from 'react';
import { useState } from 'react';

import { Modal } from '../../shared/ui';

export type Credentials = { login: string; password: string; self: boolean };

export function CredentialsDialog({
  value,
  close,
}: {
  value: Credentials;
  close: () => void;
}): JSX.Element {
  const [copy, setCopy] = useState('');

  return (
    <Modal title="Данные для входа" close={close}>
      <p>
        Операция выполнена. Сохраните данные: после закрытия этого окна пароль будет недоступен.
        {value.self && ' Все ваши сессии завершены. Войдите с новым паролем.'}
      </p>
      <dl className="admin-facts">
        <dt>Логин</dt>
        <dd>{value.login}</dd>
        <dt>Новый пароль</dt>
        <dd className="credential-password">{value.password}</dd>
      </dl>
      <div className="modal-actions">
        <button
          className="secondary"
          onClick={(): void => {
            void navigator.clipboard
              .writeText(`Логин: ${value.login}\nПароль: ${value.password}`)
              .then(
                (): void => setCopy('Скопировано'),
                (): void => setCopy('Не удалось скопировать. Выделите данные вручную.'),
              );
          }}
        >
          <Copy size={16} /> Скопировать
        </button>
        <button className="primary" onClick={close}>
          Готово
        </button>
      </div>
      <p role="status">{copy}</p>
    </Modal>
  );
}
