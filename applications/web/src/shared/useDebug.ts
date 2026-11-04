import { useSyncExternalStore } from 'react';

function enabled(): boolean {
  try {
    return localStorage.getItem('debug') !== null;
  } catch {
    return false;
  }
}

function subscribe(change: () => void): () => void {
  const storage = (event: StorageEvent): void => {
    if (event.key === 'debug' || event.key === null) change();
  };

  window.addEventListener('storage', storage);
  window.addEventListener('focus', change);

  return (): void => {
    window.removeEventListener('storage', storage);
    window.removeEventListener('focus', change);
  };
}

export function useDebug(): boolean {
  return useSyncExternalStore(subscribe, enabled);
}
