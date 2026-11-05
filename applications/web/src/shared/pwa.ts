import { embedded } from './native/bridge';

let registration: Promise<ServiceWorkerRegistration> | undefined;

export function pwaSupported(): boolean {
  return (
    !embedded && import.meta.env.PROD && window.isSecureContext && 'serviceWorker' in navigator
  );
}

export function registerPwa(): Promise<ServiceWorkerRegistration> {
  if (!pwaSupported()) return Promise.reject(new Error('PWA доступна в HTTPS-сборке приложения.'));

  registration ??= navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, {
    scope: import.meta.env.BASE_URL,
    updateViaCache: 'none',
  });

  return registration;
}

export async function readyPwa(): Promise<ServiceWorkerRegistration> {
  await registerPwa();
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<never>((_resolve, reject): void => {
        timer = setTimeout(
          (): void => reject(new Error('Не удалось запустить уведомления. Повторите попытку.')),
          15000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
