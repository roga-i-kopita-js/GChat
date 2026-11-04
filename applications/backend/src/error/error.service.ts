import { Injectable } from '@nestjs/common';

import type { AppErrorOptions, ErrorField, ErrorPayload } from './app.error.js';
import { AppError } from './app.error.js';

@Injectable()
export class ErrorService {
  create(options: AppErrorOptions): AppError {
    return new AppError(options);
  }

  private make(
    status: number,
    code: string,
    message: string,
    payload: ErrorPayload = {},
  ): AppError {
    return this.create({ status, code, message: payload.message ?? message, cause: payload.cause });
  }

  rateLimited(payload: ErrorPayload & { retryAfterSeconds: number }): AppError {
    return this.create({
      status: 429,
      code: 'RATE_LIMITED',
      message: payload.message ?? 'Слишком много попыток. Попробуйте позже.',
      retryAfterSeconds: payload.retryAfterSeconds,
      cause: payload.cause,
    });
  }

  validation(payload: ErrorPayload & { fields?: readonly ErrorField[] } = {}): AppError {
    return this.create({
      status: 400,
      code: 'VALIDATION_ERROR',
      message: payload.message ?? 'Проверьте введённые данные.',
      fields: payload.fields,
      cause: payload.cause,
    });
  }

  invalidCredentials(payload: ErrorPayload = {}): AppError {
    return this.make(
      401,
      'INVALID_CREDENTIALS',
      'Не удалось войти. Проверьте логин и пароль.',
      payload,
    );
  }

  accessTokenExpired(payload: ErrorPayload = {}): AppError {
    return this.make(401, 'ACCESS_TOKEN_EXPIRED', 'Срок действия токена истёк.', payload);
  }

  accessTokenInvalid(payload: ErrorPayload = {}): AppError {
    return this.make(401, 'ACCESS_TOKEN_INVALID', 'Токен доступа недействителен.', payload);
  }

  sessionInvalid(payload: ErrorPayload = {}): AppError {
    return this.make(401, 'SESSION_INVALID', 'Сессия недействительна. Войдите снова.', payload);
  }

  forbidden(payload: ErrorPayload = {}): AppError {
    return this.make(403, 'FORBIDDEN', 'Действие недоступно.', payload);
  }

  loginTaken(): AppError {
    return this.make(409, 'LOGIN_TAKEN', 'Логин уже занят.');
  }

  notFound(payload: ErrorPayload = {}): AppError {
    return this.make(404, 'NOT_FOUND', 'Ресурс не найден.', payload);
  }

  serviceUnavailable(payload: ErrorPayload = {}): AppError {
    return this.make(503, 'SERVICE_UNAVAILABLE', 'Сервис временно недоступен.', payload);
  }

  internal(payload: ErrorPayload = {}): AppError {
    return this.make(500, 'INTERNAL_ERROR', 'Внутренняя ошибка сервера.', payload);
  }
}
