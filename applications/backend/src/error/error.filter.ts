import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import { Catch, HttpException } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';

import { LoggerService } from '../logger/logger.service.js';
import { AppError } from './app.error.js';
import { ReadinessError } from './readiness.error.js';

const standardErrors: Record<number, [string, string]> = {
  400: ['VALIDATION_ERROR', 'Проверьте введённые данные.'],
  401: ['ACCESS_TOKEN_INVALID', 'Токен доступа недействителен.'],
  403: ['FORBIDDEN', 'Действие недоступно.'],
  404: ['NOT_FOUND', 'Ресурс не найден.'],
  413: ['PAYLOAD_TOO_LARGE', 'Размер запроса превышает допустимый.'],
  429: ['RATE_LIMITED', 'Слишком много попыток. Попробуйте позже.'],
  500: ['INTERNAL_ERROR', 'Внутренняя ошибка сервера.'],
  503: ['SERVICE_UNAVAILABLE', 'Сервис временно недоступен.'],
};

@Catch()
export class ErrorFilter implements ExceptionFilter {
  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly logger: LoggerService,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const adapter = this.adapterHost.httpAdapter;
    const context = host.switchToHttp();
    const response = context.getResponse();

    if (adapter.isHeadersSent(response)) return;

    const path = adapter.getRequestUrl(context.getRequest()).split('?')[0];

    if (
      /^\/dialogs(?:\/|$)/i.test(path) ||
      path === '/auth' ||
      path.startsWith('/auth/') ||
      path === '/admin' ||
      path.startsWith('/admin/')
    ) {
      adapter.setHeader(response, 'Cache-Control', 'no-store');
    }

    if (exception instanceof ReadinessError && path === '/ready') {
      adapter.reply(response, exception.readiness, 503);

      return;
    }

    const status =
      exception instanceof AppError
        ? exception.status
        : exception instanceof HttpException
          ? exception.getStatus()
          : exception instanceof Error && 'status' in exception && exception.status === 413
            ? 413
            : exception instanceof SyntaxError && 'status' in exception && exception.status === 400
              ? 400
              : 500;
    const [code, message] = standardErrors[status] ?? ['HTTP_ERROR', 'Ошибка HTTP-запроса.'];
    const error =
      exception instanceof AppError
        ? {
            code: exception.code,
            message: exception.message,
            ...(exception.fields?.length
              ? {
                  fields: exception.fields.map(
                    ({ field, code }): { field: string; code: string } => ({ field, code }),
                  ),
                }
              : {}),
          }
        : { code, message };

    if (
      exception instanceof AppError &&
      status === 429 &&
      exception.retryAfterSeconds !== undefined
    ) {
      adapter.setHeader(response, 'Retry-After', String(exception.retryAfterSeconds));
    }

    if (status >= 500) {
      this.logger.error('HTTP request failed', { status, code: error.code });
    }

    adapter.reply(response, { error }, status);
  }
}
