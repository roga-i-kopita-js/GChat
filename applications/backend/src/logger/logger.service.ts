import { Inject, Injectable, Optional, Scope } from '@nestjs/common';
import type { LoggerService as NestLoggerService } from '@nestjs/common';
import { INQUIRER } from '@nestjs/core';
import { LoggerContext } from './logger-context.js';
import type { LogContext } from './logger-context.js';
import { LoggerSettings } from './logger-settings.js';
import { sanitizeLogValue } from './log-sanitizer.js';

type Level = 'info' | 'warn' | 'error' | 'debug' | 'verbose' | 'fatal';

@Injectable({ scope: Scope.TRANSIENT })
export class LoggerService implements NestLoggerService {
  private owner: LogContext;
  private readonly redaction: boolean;

  constructor(
    @Optional() settings?: LoggerSettings,
    @Optional() registry?: LoggerContext,
    @Optional() @Inject(INQUIRER) inquirer?: object,
  ) {
    this.redaction = settings?.redactionEnabled ?? true;
    this.owner = registry?.resolve(inquirer) ?? { module: null };
  }

  bindContext(context: LogContext): void { this.owner = { ...context }; }

  log(message: unknown, ...params: unknown[]): void { this.write('info', message, params); }
  warn(message: unknown, ...params: unknown[]): void { this.write('warn', message, params); }
  error(message: unknown, ...params: unknown[]): void { this.write('error', message, params, true); }
  debug(message: unknown, ...params: unknown[]): void { this.write('debug', message, params); }
  verbose(message: unknown, ...params: unknown[]): void { this.write('verbose', message, params); }
  fatal(message: unknown, ...params: unknown[]): void { this.write('fatal', message, params, true); }

  private write(level: Level, message: unknown, params: unknown[], omitTrace = false): void {
    try {
      const args = [...params];
      const suppliedContext = typeof args.at(-1) === 'string' ? args.pop() as string : undefined;
      const context = this.owner.context ?? suppliedContext;
      const clean = (value: unknown) => sanitizeLogValue(value, this.redaction);
      // Nest error(message, stack, context): omit traces when redaction is enabled.
      const metadata = args.filter((arg) => arg !== undefined && (!omitTrace || !this.redaction || typeof arg !== 'string'));
      const record = {
        timestamp: new Date().toISOString(), level, service: 'gchat-backend',
        module: this.owner.module,
        ...(context ? { context: clean(context) } : {}),
        message: clean(message),
        ...(metadata.length ? { metadata: clean(metadata) } : {}),
      };
      const stream = level === 'error' || level === 'fatal' ? process.stderr : process.stdout;
      stream.write(`${JSON.stringify(record)}\n`);
    } catch {
      // Logging failure must not fail a request or recursively log the same error.
    }
  }
}
