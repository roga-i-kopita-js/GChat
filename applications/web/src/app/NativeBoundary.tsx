import { useQueryClient } from '@tanstack/react-query';
import {
  type JSX,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
} from 'react';
import { useNavigate } from 'react-router';

import { nativeRuntime } from '../shared/native/runtime';

export function NativeBoundary({ children }: { children: ReactNode }): JSX.Element {
  const state = useSyncExternalStore(nativeRuntime.subscribe, nativeRuntime.getSnapshot);
  const cache = useQueryClient();
  const navigate = useNavigate();
  const appliedRoute = useRef(state.route);

  useEffect((): (() => void) => {
    const ready = (): void => {
      void nativeRuntime.ready();
    };
    const visibility = (): void => {
      if (document.visibilityState === 'visible') ready();
    };
    const unsubscribe = nativeRuntime.subscribe((): void => {
      if (nativeRuntime.getSnapshot().phase !== 'ready') {
        void cache.cancelQueries();
        cache.clear();
      }
    });

    ready();
    document.addEventListener('visibilitychange', visibility);

    return (): void => {
      document.removeEventListener('visibilitychange', visibility);
      unsubscribe();
      nativeRuntime.stop();
    };
  }, [cache]);
  useLayoutEffect((): void => {
    if (state.phase !== 'ready') {
      void cache.cancelQueries();
      cache.clear();
    }
  }, [cache, state.phase, state.cycleId]);
  useLayoutEffect((): void => {
    if (state.phase === 'ready' && state.route && appliedRoute.current !== state.route) {
      appliedRoute.current = state.route;
      void navigate(state.route.path, { replace: state.route.replace });
    }
  }, [navigate, state.route, state.phase]);

  if (state.phase !== 'ready')
    return (
      <main className="unsupported">
        <p role={state.error ? 'alert' : 'status'}>{state.error ?? 'Подключаемся к приложению…'}</p>
        <button
          className="primary"
          onClick={(): void => {
            void nativeRuntime.ready();
          }}
        >
          Повторить
        </button>
      </main>
    );

  return (
    <section key={state.epoch} style={{ display: 'contents' }}>
      {children}
    </section>
  );
}
