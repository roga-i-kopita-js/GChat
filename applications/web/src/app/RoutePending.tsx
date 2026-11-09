import type { JSX } from 'react';
import { useLayoutEffect, useState } from 'react';
import { useNavigation, useRevalidator } from 'react-router';

import { LoadingBar } from '../shared/ui';

export function RoutePending(): JSX.Element | null {
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const busy = navigation.state !== 'idle' || revalidator.state !== 'idle';
  const [visible, setVisible] = useState(busy);

  useLayoutEffect((): void => {
    if (busy) {
      setVisible(true);
    }
  }, [busy]);

  return !busy && !visible ? null : (
    <LoadingBar
      className="route-loading-bar"
      complete={!busy}
      onComplete={(): void => {
        if (!busy) {
          setVisible(false);
        }
      }}
      aria-label={navigation.state === 'submitting' ? 'Сохранение' : 'Загрузка страницы'}
    />
  );
}
