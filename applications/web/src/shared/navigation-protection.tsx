import type { JSX, ReactNode } from 'react';
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useBlocker } from 'react-router';

import { SessionEvent, type SessionService, type SessionState } from './device/api';
import { useDeviceState } from './device/react';
import { retainFrontendUpdate } from './frontend-update-lease';
import { subscribeUpdate, updateSnapshot } from './pwa-update';
import { Modal } from './ui';

export interface NavigationProtection {
  dirty(): boolean;
  flush?(): Promise<void>;
  discard(): void;
}

interface Entry {
  scope: number;
  protection: NavigationProtection;
}

/** Stores callbacks only; form values and passwords remain owned by their mounted form. */
export class NavigationProtections {
  private entries = new Set<Entry>();
  private scope: number | null = null;

  setSession(state: SessionState): void {
    this.scope = state.status === 'authenticated' ? state.generation : null;
  }

  register(protection: NavigationProtection): () => void {
    const entry: Entry = { scope: this.scope ?? -1, protection };

    this.entries.add(entry);

    return (): void => {
      this.entries.delete(entry);
    };
  }

  private current(): NavigationProtection[] {
    return [...this.entries]
      .filter((entry): boolean => entry.scope === this.scope && entry.protection.dirty())
      .map((entry): NavigationProtection => entry.protection);
  }

  dirty(): boolean {
    return this.current().length > 0;
  }

  async prepare(): Promise<'ready' | 'confirm' | 'failed'> {
    const scope = this.scope;

    try {
      for (const entry of this.current()) {
        if (entry.flush) {
          await entry.flush();
        }

        if (this.scope !== scope) {
          return 'ready';
        }
      }
    } catch {
      return this.scope === scope ? 'failed' : 'ready';
    }

    return this.dirty() ? 'confirm' : 'ready';
  }

  discard(): void {
    for (const entry of this.current()) {
      entry.discard();
    }
  }
}

const Context = createContext<NavigationProtections | null>(null);

export function useNavigationProtection(protection: NavigationProtection): boolean {
  const [held, setHeld] = useState(false);
  const update = useSyncExternalStore(subscribeUpdate, updateSnapshot);
  const registry = useContext(Context);
  const latest = useRef(protection);

  latest.current = protection;
  useLayoutEffect((): (() => void) => {
    if (!registry) {
      throw new Error('NavigationProtectionRoot is required');
    }

    const off = registry.register({
      dirty: (): boolean => latest.current.dirty(),
      flush: protection.flush
        ? async (): Promise<void> => {
            await latest.current.flush?.();
          }
        : undefined,
      discard: (): void => latest.current.discard(),
    });
    // Drafts already own their runtime's flush lease; forms retain theirs through editing and submission.
    const lease = protection.flush ? null : retainFrontendUpdate();
    let active = true;

    void (async () => {
      if (!lease) {
        return;
      }

      try {
        await lease.ready;
      } catch (rejectedCause) {
        return;
      }

      if (active) {
        setHeld(true);
      }
    })();

    return (): void => {
      active = false;
      off();
      lease?.release();
    };
  }, [registry]);

  return update.pending && !held && !protection.flush;
}

export function NavigationProtectionRoot<THttp>({
  session,
  children,
}: {
  session: SessionService<THttp>;
  children: ReactNode;
}): JSX.Element {
  const [registry] = useState((): NavigationProtections => new NavigationProtections());
  const state = useDeviceState(session, SessionEvent.StateChanged);

  registry.setSession(state);
  // Session invalidation must bypass the blocker before an auth listener asks Router to redirect.
  useLayoutEffect(
    (): (() => void) =>
      session.on(SessionEvent.StateChanged, (next): void => registry.setSession(next)),
    [registry, session],
  );
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }): boolean =>
      registry.dirty() &&
      (currentLocation.pathname !== nextLocation.pathname ||
        currentLocation.search !== nextLocation.search ||
        currentLocation.hash !== nextLocation.hash),
  );
  const [choice, setChoice] = useState<'preparing' | 'confirm' | 'failed'>('preparing');
  const pending = useRef(blocker);

  pending.current = blocker;
  const sequence = useRef(0);
  const prepare = async (): Promise<void> => {
    const generation = ++sequence.current;
    const selected = pending.current;

    if (selected.state !== 'blocked') {
      return;
    }

    setChoice('preparing');
    const result = await registry.prepare();

    if (generation !== sequence.current || pending.current !== selected) {
      return;
    }

    if (result === 'ready') {
      selected.proceed();
    } else {
      setChoice(result);
    }
  };

  useEffect((): (() => void) => {
    if (blocker.state === 'blocked') {
      void prepare();
    }

    return (): void => {
      sequence.current++;
    };
  }, [blocker]);
  useEffect((): void => {
    if (state.status !== 'authenticated' && blocker.state === 'blocked') {
      blocker.proceed();
    }
  }, [state.status, state.generation, blocker]);
  useEffect((): (() => void) => {
    const unload = (event: BeforeUnloadEvent): void => {
      if (registry.dirty()) {
        event.preventDefault();
        event.returnValue = '';
      }
    };

    window.addEventListener('beforeunload', unload);

    return (): void => window.removeEventListener('beforeunload', unload);
  }, [registry]);

  return (
    <Context value={registry}>
      {children}
      {blocker.state === 'blocked' && (
        <Modal
          title="Несохранённые изменения"
          close={(): void => {
            if (choice !== 'preparing') {
              blocker.reset();
            }
          }}
        >
          {choice === 'preparing' ? (
            <p role="status">Сохраняем черновик…</p>
          ) : (
            <>
              <p>
                {choice === 'failed'
                  ? 'Не удалось сохранить черновик. Можно повторить сохранение или уйти без несохранённого ввода.'
                  : 'В форме есть несохранённые изменения. Уйти со страницы?'}
              </p>
              <div className="modal-actions">
                <button className="secondary" onClick={(): void => blocker.reset()}>
                  Остаться
                </button>
                {choice === 'failed' && (
                  <button
                    className="secondary"
                    onClick={(): void => {
                      void prepare();
                    }}
                  >
                    Повторить сохранение
                  </button>
                )}
                <button
                  className="danger-button"
                  onClick={(): void => {
                    registry.discard();
                    blocker.proceed();
                  }}
                >
                  Уйти без сохранения
                </button>
              </div>
            </>
          )}
        </Modal>
      )}
    </Context>
  );
}
