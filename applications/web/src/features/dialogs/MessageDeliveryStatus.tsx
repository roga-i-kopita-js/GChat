import { Check, CheckCheck, CircleAlert, Clock3 } from 'lucide-react';
import type { JSX } from 'react';

export type MessageDeliveryState = 'sending' | 'sent' | 'read' | 'unknown' | 'rejected';

const states = {
  sending: { Icon: Clock3, label: 'Отправляется' },
  sent: { Icon: Check, label: 'Отправлено' },
  read: { Icon: CheckCheck, label: 'Прочитано' },
  unknown: { Icon: CircleAlert, label: 'Результат неизвестен' },
  rejected: { Icon: CircleAlert, label: 'Отклонено' },
};

export function MessageDeliveryStatus({ state }: { state: MessageDeliveryState }): JSX.Element {
  const { Icon, label } = states[state];

  return (
    <span
      className="dialog-message-delivery"
      data-state={state}
      role="img"
      aria-label={label}
      title={label}
    >
      <Icon aria-hidden="true" />
    </span>
  );
}
