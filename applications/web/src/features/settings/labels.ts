import type { PermissionState } from '../../shared/device/contract';

export const permissionLabels: Record<PermissionState['permission'], string> = {
  unknown: 'Неизвестно',
  prompt: 'Не запрошен',
  denied: 'Запрещён',
  restricted: 'Ограничен',
  granted: 'Разрешён',
  limited: 'Ограничен',
};

export const descriptions: Record<string, string> = {
  microphone: 'Микрофон нужен, чтобы собеседник слышал вас во время звонка.',
  camera: 'Здесь можно разрешить доступ к камере. Съёмка фото и видео пока не используется.',
  geolocation:
    'Разрешение геопозиции при использовании приложения. Координаты не сохраняются и не отправляются.',
  audio: 'Проверьте слышимость короткого сигнала перед звонком.',
  push: 'Push-уведомления помогают узнать о входящем звонке, когда GChat закрыт.',
  files: 'Выберите файлы и папки, к которым GChat сможет обращаться на этом устройстве.',
};

export const titles: Record<string, string> = {
  microphone: 'Микрофон',
  audio: 'Динамики и звук',
  push: 'Push-уведомления',
  camera: 'Камера',
  geolocation: 'Геопозиция',
  files: 'Файлы и папки',
};

export function pushStatus(
  state: import('../../shared/device/contract').DeviceState | null,
): string {
  return !state
    ? 'Проверяем…'
    : {
        enabled: 'Включены',
        disabled: 'Выключены',
        unavailable: 'Недоступны',
        enabling: 'Включаем…',
        error: 'Ошибка',
      }[state.push.delivery];
}
