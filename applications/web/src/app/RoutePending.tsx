import type { JSX } from 'react';
import { useNavigation } from 'react-router';

export function RoutePending(): JSX.Element | null {
  const navigation = useNavigation();

  return navigation.state === 'idle' ? null : (
    <div className="tab-banner" role="status" aria-live="polite">
      {navigation.state === 'submitting' ? 'Сохраняем…' : 'Загружаем страницу…'}
    </div>
  );
}
