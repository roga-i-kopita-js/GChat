import type { JSX, ReactElement, ReactNode } from 'react';
import {
  createContext,
  Suspense,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

import type { CallOptions, CameraPreviewProps, DeviceCore, Unsubscribe, Versioned } from './api';
import { CallEvent, LifecycleEvent } from './api';
import { BrowserCamera } from './camera-browser';
import { NativeCamera } from './camera-native';
import { DeviceError } from './contract';
import { deviceInternals, isDevice, type PresentationState } from './internals';
import { stateCache } from './state-cache';

const Context = createContext<unknown>(null);

export function useDevice(): DeviceCore {
  const value = useContext(Context);

  if (!isDevice(value)) {
    throw new DeviceError('INTEGRATION_ERROR');
  }

  return value;
}

export function useDeviceState<TState extends Versioned, const TEvent extends string>(
  service: {
    getState(options?: CallOptions): Promise<TState>;
    on(event: NoInfer<TEvent>, handler: (state: NoInfer<TState>) => void): Unsubscribe;
  },
  event: TEvent,
): TState {
  const cache = stateCache(service, event);

  cache.ensure();
  const snapshot = useSyncExternalStore(cache.subscribe, cache.getSnapshot);

  if (snapshot.status === 'loading') {
    throw snapshot.promise;
  }

  if (snapshot.status === 'error') {
    throw snapshot.error;
  }

  return snapshot.value;
}

function LifecycleRoot({ device }: { device: DeviceCore }): ReactElement {
  const state = useDeviceState(device.lifecycle, LifecycleEvent.StateChanged);

  if (state.phase !== 'ready') {
    return (
      <main className="unsupported">
        <p role={state.error ? 'alert' : 'status'}>
          {state.error?.message ??
            (state.phase === 'stopped'
              ? 'Приложение остановлено. Обновите страницу.'
              : 'Подключаем GChat…')}
        </p>
        {state.phase === 'error' && (
          <button
            className="primary"
            onClick={(): void => {
              void device.lifecycle.retry().catch((): void => {});
            }}
          >
            Повторить
          </button>
        )}
      </main>
    );
  }

  return deviceInternals(device).render();
}

export function DeviceProvider<THttp>({ device }: { device: DeviceCore<THttp> }): ReactElement {
  const id = useId();
  const record = deviceInternals(device);

  if (record.provider !== null && record.provider !== id) {
    throw new DeviceError('INTEGRATION_ERROR');
  }

  record.provider = id;
  useLayoutEffect((): (() => void) => {
    if (record.provider !== null && record.provider !== id) {
      throw new DeviceError('INTEGRATION_ERROR');
    }

    record.provider = id;

    return (): void => {
      if (record.provider === id) {
        record.provider = null;
      }
    };
  }, [record, id]);

  return (
    <Context value={device}>
      <Suspense fallback={<main role="status">Загружаем GChat…</main>}>
        <LifecycleRoot device={device} />
      </Suspense>
    </Context>
  );
}

export function useDevicePresentation(): PresentationState {
  const record = deviceInternals(useDevice());

  return useSyncExternalStore(
    (listener): Unsubscribe => record.presentation.on(listener),
    record.presentation.getSnapshot,
  );
}

export interface CallPresentationState {
  owner: boolean;
  connection: 'offline' | 'connecting' | 'online';
  call: import('./api').DeviceCall | null;
  selected: boolean;
  muted: boolean;
  busy: boolean;
  error: string | null;
  audioBlocked: boolean;
  audible: boolean;
  media: string;
  stats: { relay: boolean; sent: number; received: number };
}

export function useDeviceCallSnapshot(): CallPresentationState {
  const device = useDevice();
  const record = deviceInternals(device);
  const raw = useSyncExternalStore(record.client.subscribe, record.client.getSnapshot);
  const state = useDeviceState(device.calls, CallEvent.StateChanged);

  return { ...raw, error: state.error?.message ?? null };
}

export function useDeviceSettingsSnapshot(): import('./contract').DeviceState | null {
  const record = deviceInternals(useDevice());
  const snapshot = useSyncExternalStore(
    (listener): Unsubscribe => record.observer.source.on(listener),
    record.observer.source.getSnapshot,
  );

  return snapshot.value;
}

export function useDeviceSettings(): {
  state: import('./contract').DeviceState | null;
  refresh(): Promise<import('./contract').DeviceState>;
} {
  const device = useDevice();
  const state = useDeviceSettingsSnapshot();
  const record = deviceInternals(device);

  return {
    state,
    refresh: (): Promise<import('./contract').DeviceState> => record.observer.refresh(),
  };
}

function CameraPreviewElement<THttp>({
  device,
  source,
  className,
  visible = true,
  priority,
}: CameraPreviewProps<THttp> & { priority: 'view' | 'call' }): ReactElement {
  const record = deviceInternals(device);
  const video = useRef<HTMLVideoElement>(null);
  const view = useRef<HTMLDivElement>(null);
  const previewId = useId();
  const [error, setError] = useState<unknown>(null);

  useLayoutEffect((): (() => void) => {
    const adapter = record.camera;

    if (adapter instanceof BrowserCamera) {
      if (!video.current) {
        return (): void => {};
      }

      video.current.hidden = !visible;

      return adapter.attach(source, video.current);
    }

    if (!(adapter instanceof NativeCamera) || !view.current) {
      throw new DeviceError('INTEGRATION_ERROR');
    }

    const element = view.current;
    let active = true;
    let frame = 0;
    const clearHole = (): void => {
      if (document.documentElement.dataset.gchatCameraOwner !== previewId) {
        return;
      }

      delete document.documentElement.dataset.gchatCameraOwner;
      delete document.documentElement.dataset.gchatCameraPriority;
      document.documentElement.classList.remove('native-camera-surface-visible');
      document.documentElement.style.removeProperty('--native-camera-clip');
    };
    const update = (): void => {
      if (!active) {
        return;
      }

      const bounds = element.getBoundingClientRect();
      const transform = getComputedStyle(element).transform;

      if (transform !== 'none') {
        setError(new DeviceError('UNSUPPORTED'));

        return;
      }

      let shown =
        visible &&
        !document.hidden &&
        bounds.width > 0 &&
        bounds.height > 0 &&
        bounds.bottom > 0 &&
        bounds.right > 0 &&
        bounds.top < window.innerHeight &&
        bounds.left < window.innerWidth;

      if (
        document.querySelector('dialog[open]') ||
        (priority === 'call' && hasPagePreview(source.id))
      ) {
        shown = false;
      }

      const page = document.querySelector('[data-gchat-surface]');

      const owner = document.documentElement.dataset.gchatCameraOwner;
      const ownedByOtherView =
        owner &&
        owner !== previewId &&
        document.documentElement.dataset.gchatCameraPriority === 'view' &&
        priority === 'view';

      if (shown && page && !ownedByOtherView) {
        const origin = page.getBoundingClientRect();
        const x = bounds.x - origin.x;
        const y = bounds.y - origin.y;

        document.documentElement.dataset.gchatCameraOwner = previewId;
        document.documentElement.dataset.gchatCameraPriority = priority;
        document.documentElement.style.setProperty(
          '--native-camera-clip',
          `polygon(evenodd,0 0,100% 0,100% 100%,0 100%,0 0,${x}px ${y}px,${x}px ${y + bounds.height}px,${x + bounds.width}px ${y + bounds.height}px,${x + bounds.width}px ${y}px,${x}px ${y}px)`,
        );
        document.documentElement.classList.add('native-camera-surface-visible');
      } else if (!ownedByOtherView) {
        clearHole();
      }

      void adapter
        .bind(
          source,
          { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
          shown,
          previewId,
          priority,
        )
        .catch((cause): void => {
          if (active) {
            setError(cause);
          }
        });
    };
    const schedule = (): void => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };
    const observer = new ResizeObserver(schedule);

    observer.observe(element);
    const modals = new MutationObserver(schedule);

    modals.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['open'],
    });
    window.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);
    document.addEventListener('visibilitychange', schedule);
    update();

    return (): void => {
      active = false;
      cancelAnimationFrame(frame);
      observer.disconnect();
      modals.disconnect();
      clearHole();
      window.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
      document.removeEventListener('visibilitychange', schedule);
      void adapter
        .bind(source, { x: 0, y: 0, width: 0, height: 0 }, false, previewId, priority)
        .catch((): void => {});
    };
  }, [record, source.id, visible, previewId, priority]);

  if (error) {
    throw error;
  }

  return record.camera instanceof BrowserCamera ? (
    <video
      ref={video}
      className={className}
      muted
      playsInline
      data-gchat-camera-preview={source.id}
      data-gchat-camera-priority={priority}
      data-gchat-camera-visible={visible}
    />
  ) : (
    <div
      ref={view}
      data-gchat-camera-preview={source.id}
      data-gchat-camera-priority={priority}
      data-gchat-camera-visible={visible}
      className={className}
      aria-label="Предпросмотр камеры"
      style={{ background: 'transparent' }}
    />
  );
}

export function DeviceCameraPreview<THttp>(props: CameraPreviewProps<THttp>): ReactElement {
  return <CameraPreviewElement {...props} priority="view" />;
}

function hasPagePreview(id: string): boolean {
  return [
    ...document.querySelectorAll(
      '[data-gchat-camera-priority="view"][data-gchat-camera-visible="true"]',
    ),
  ].some((element): boolean => {
    const rect = element.getBoundingClientRect();

    return (
      element.getAttribute('data-gchat-camera-preview') === id &&
      rect.width > 0 &&
      rect.height > 0 &&
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < window.innerHeight &&
      rect.left < window.innerWidth
    );
  });
}

/** A call-owned surface outlives the page that opened the camera. */
export function DeviceCallCameraHost(): ReactElement | null {
  const device = useDevice();
  const camera = deviceInternals(device).camera;
  const snapshot = useSyncExternalStore(
    (listener): Unsubscribe => camera.callPreview.on(listener),
    camera.callPreview.getSnapshot,
  );
  const [visible, setVisible] = useState(true);

  useEffect((): (() => void) => {
    const inspect = (): void =>
      setVisible(
        !document.querySelector('dialog[open]') &&
          (!snapshot.source || !hasPagePreview(snapshot.source.id)),
      );
    const observer = new MutationObserver(inspect);

    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['open', 'data-gchat-camera-visible'],
    });
    window.addEventListener('scroll', inspect, true);
    window.addEventListener('resize', inspect);
    inspect();

    return (): void => {
      observer.disconnect();
      window.removeEventListener('scroll', inspect, true);
      window.removeEventListener('resize', inspect);
    };
  }, [snapshot.source?.id]);

  if (!snapshot.source) {
    return null;
  }

  return (
    <aside className="call-camera-preview" hidden={!visible} aria-label="Камера текущего звонка">
      <CameraPreviewElement
        device={device}
        source={snapshot.source}
        visible={visible}
        priority="call"
      />
      {snapshot.status === 'interrupted' && <p role="status">Камера приостановлена</p>}
    </aside>
  );
}
