import { ApiError } from '@gchat/backend-api';

/** 24 independent base64 symbols provide 144 bits of entropy without modulo bias. */
export function generatePassword(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

  return Array.from(
    crypto.getRandomValues(new Uint8Array(24)),
    (byte): string => alphabet[byte & 63],
  ).join('');
}

export function mutationError(cause: unknown): string {
  if (cause instanceof ApiError && cause.status >= 400 && cause.status < 500 && cause.code) {
    if (cause.code === 'LOGIN_TAKEN') {
      return 'Логин уже занят. Укажите другой.';
    }

    if (cause.code === 'FORBIDDEN') {
      return 'Недостаточно прав для этой операции.';
    }

    if (cause.code === 'VALIDATION_ERROR') {
      return 'Проверьте имя, группу, логин и длину пароля (15–128 символов).';
    }

    if (cause.code === 'NOT_FOUND') {
      return 'Аккаунт больше не найден. Обновите список.';
    }

    return 'Операция отклонена. Проверьте доступ и данные перед новым действием.';
  }

  return 'Результат операции неизвестен. Обновите список и карточку для проверки состояния. Карточка не подтверждает установку пароля. Не повторяйте создание вслепую; при необходимости выполните отдельную смену пароля.';
}
