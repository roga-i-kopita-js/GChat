import type { JSX } from 'react';

export function SessionPending(): JSX.Element {
  return (
    <main className="unsupported" role="status">
      <p>Восстанавливаем сессию…</p>
    </main>
  );
}
