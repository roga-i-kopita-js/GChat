import { MessageCircle } from 'lucide-react';
import type { JSX } from 'react';

export function DialogIndexRoute(): JSX.Element {
  return (
    <section className="dialog-room dialog-placeholder">
      <div className="dialog-empty">
        <MessageCircle size={40} />
        <h2>Выберите диалог</h2>
        <p>Ваши переписки — в списке слева</p>
      </div>
    </section>
  );
}
