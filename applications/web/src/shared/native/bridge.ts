import { Capacitor, type PluginListenerHandle, registerPlugin } from '@capacitor/core';
import { z } from 'zod';

import { ClientError } from '../api/client';

export const bridgeVersion = 1;

interface NativePlugin {
  getCapabilities(): Promise<unknown>;
  webReady(options: { bridgeVersion: number; cycleId: string }): Promise<void>;
  login(options: { serverUrl: string; login: string; password: string }): Promise<void>;
  logout(): Promise<void>;
  getAccessToken(options: { forceRefresh: boolean }): Promise<unknown>;
  placeCall(options: { peerId: string }): Promise<void>;
  addListener(name: string, listener: (event: unknown) => void): Promise<PluginListenerHandle>;
}

export const nativePlugin = registerPlugin<NativePlugin>('GChat');

declare global {
  interface Window {
    GChatRuntime?: 'native';
  }
}

/** The selection is fixed for the lifetime of the document; bridge failure never selects browser. */
export const embedded =
  import.meta.env.VITE_GCHAT_RUNTIME === 'native' ||
  (typeof window !== 'undefined' && window.GChatRuntime === 'native') ||
  Capacitor.isNativePlatform();

const messages: Record<string, string> = {
  BRIDGE_UNAVAILABLE: 'Связь с приложением недоступна',
  UNSUPPORTED_VERSION: 'Обновите приложение для продолжения',
  VALIDATION_ERROR: 'Некорректные данные мобильной интеграции',
  SECURE_STORAGE_ERROR: 'Не удалось прочитать или сохранить сессию',
  UNAUTHENTICATED: 'Войдите в аккаунт',
  INVALID_CREDENTIALS: 'Неверный логин или пароль',
  SERVICE_UNAVAILABLE: 'Сервис временно недоступен',
  SESSION_INVALID: 'Сессия завершена. Войдите снова',
  NETWORK_ERROR: 'Проверьте соединение и повторите попытку',
  RATE_LIMITED: 'Слишком много запросов. Попробуйте позже',
};

export function bridgeError(cause: unknown): ClientError {
  const parsed = z
    .object({
      code: z.string(),
      retryAfter: z.number().nonnegative().optional(),
      data: z.object({ retryAfter: z.number().nonnegative().optional() }).optional(),
    })
    .safeParse(cause);
  const code =
    parsed.success && messages[parsed.data.code] ? parsed.data.code : 'BRIDGE_UNAVAILABLE';

  return new ClientError(
    code,
    messages[code],
    parsed.success ? (parsed.data.retryAfter ?? parsed.data.data?.retryAfter ?? 0) : 0,
  );
}

export async function invoke<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (cause) {
    throw bridgeError(cause);
  }
}

export function serverUrl(value: string): string {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw bridgeError({ code: 'VALIDATION_ERROR' });
  }

  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw bridgeError({ code: 'VALIDATION_ERROR' });

  if (url.origin !== window.location.origin) throw bridgeError({ code: 'VALIDATION_ERROR' });

  return url.origin;
}
