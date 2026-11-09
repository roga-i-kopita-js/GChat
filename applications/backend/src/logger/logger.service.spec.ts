import { jest } from '@jest/globals';
import { Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { LoggerModule } from './logger.module.js';
import { LoggerService } from './logger.service.js';
import { LoggerSettings, parseLogRedaction } from './logger-settings.js';

@Injectable()
class Consumer {
  constructor(readonly logger: LoggerService) {}
}
@Module({ providers: [Consumer] })
class ConsumerModule {}

describe('LoggerService', (): void => {
  afterEach((): ReturnType<typeof jest.restoreAllMocks> => jest.restoreAllMocks());

  it('does not register providers on a bare module import', async (): Promise<void> => {
    const module = await Test.createTestingModule({ imports: [LoggerModule] }).compile();

    const { init: moduleInit } = module;

    await moduleInit.bind(module)();
    expect((): LoggerService => {
      const { get: moduleGet } = module;

      return moduleGet.bind(module)(LoggerService);
    }).toThrow();
    expect((): LoggerSettings => {
      const { get: moduleGet2 } = module;

      return moduleGet2.bind(module)(LoggerSettings);
    }).toThrow();
    const { close: moduleClose } = module;

    await moduleClose.bind(module)();
  });

  it('is injected globally into a separate module', async (): Promise<void> => {
    const module = await Test.createTestingModule({
      imports: [LoggerModule.forRoot(), ConsumerModule],
    }).compile();

    const { get: moduleGet3 } = module;

    expect(moduleGet3.bind(module)(Consumer).logger).toBeInstanceOf(LoggerService);
    const { close: moduleClose2 } = module;

    await moduleClose2.bind(module)();
  });

  it('writes one JSON record per event and routes errors to stderr', (): void => {
    const stdout = jest.spyOn(process.stdout, 'write').mockReturnValue(true);
    const stderr = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
    const logger = new LoggerService();

    logger.log('Started\nwith newline', { port: 3000 }, 'Bootstrap');
    logger.error('Failed', undefined, 'Redis');
    const line = stdout.mock.calls[0]![0] as string;

    expect(line.split('\n')).toHaveLength(2);
    expect(JSON.parse(line)).toMatchObject({
      timestamp: expect.any(String),
      level: 'info',
      service: 'gchat-backend',
      context: 'Bootstrap',
      message: 'Started\nwith newline',
      metadata: [{ port: 3000 }],
    });
    expect(JSON.parse(stderr.mock.calls[0]![0] as string)).toMatchObject({
      level: 'error',
      context: 'Redis',
    });
  });

  it('redacts nested secrets, credentials, tokens and arbitrary driver errors', (): void => {
    const stdout = jest.spyOn(process.stdout, 'write').mockReturnValue(true);
    const stderr = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
    const logger = new LoggerService();

    logger.warn(
      'Connect redis://user:private-url@host password=private-pass Bearer private-bearer',
      {
        nested: {
          refresh_token: 'private-refresh',
          authorization: 'private-auth',
          privateKey: 'private-key',
        },
        error: new Error('private-driver'),
        database_url: 'private-db',
        headers: { x: 'private-header' },
      },
      'Redis',
    );
    logger.error(new Error('private-error'), 'private-stack', 'Bootstrap');
    const records = String(stdout.mock.calls[0]![0]) + String(stderr.mock.calls[0]![0]);

    expect(records).not.toContain('private-');
    expect(records).toContain('[REDACTED]');
    expect(records).toContain('[REDACTED_URL]');
  });

  it('handles cycles, bigint, depth and getters without serializing unsafe objects', (): void => {
    const stdout = jest.spyOn(process.stdout, 'write').mockReturnValue(true);
    const getter = jest.fn((): string => 'private-getter');
    const data: Record<string, unknown> = { value: 123n };

    data.self = data;
    Object.defineProperty(data, 'computed', { enumerable: true, get: getter });
    Object.defineProperty(data, 'toJSON', {
      enumerable: true,
      value: (): never => {
        throw new Error('unsafe');
      },
    });
    new LoggerService().debug('Details', data, 'Test');
    expect(getter).not.toHaveBeenCalled();
    expect(JSON.parse(stdout.mock.calls[0]![0] as string)).toMatchObject({
      metadata: [
        { value: '123', self: '[Circular]', computed: '[Accessor]', toJSON: '[Unsupported]' },
      ],
    });
  });

  it('disables masking while preserving serialization safety', (): void => {
    const stdout = jest.spyOn(process.stdout, 'write').mockReturnValue(true);
    const settings = { redactionEnabled: false } as LoggerSettings;
    const data: Record<string, unknown> = {
      password: 'visible-password',
      error: new Error('visible-error'),
    };

    data.self = data;
    new LoggerService(settings).log('redis://user:password@host', data);
    const record = JSON.parse(stdout.mock.calls[0]![0] as string);

    expect(record.message).toBe('redis://user:password@host');
    expect(record.metadata[0]).toMatchObject({
      password: 'visible-password',
      error: { message: 'visible-error' },
      self: '[Circular]',
    });
  });

  it('validates redaction configuration explicitly', (): void => {
    expect(parseLogRedaction(undefined)).toBe(true);
    expect(parseLogRedaction('true')).toBe(true);
    expect(parseLogRedaction('false')).toBe(false);

    for (const value of ['', '1', 'TRUE', 'no', 0]) {
      expect((): boolean => parseLogRedaction(value)).toThrow();
    }
  });

  it('does not propagate output failures into business code', (): void => {
    jest.spyOn(process.stderr, 'write').mockImplementation((): never => {
      throw new Error('stream failure');
    });
    expect((): void => new LoggerService().error('Failed', 'Test')).not.toThrow();
  });
});

@Injectable()
class SharedConsumer {
  constructor(readonly logger: LoggerService) {}
}
@Module({ providers: [SharedConsumer], exports: [SharedConsumer] })
class FirstModule {}
@Module({ providers: [SharedConsumer], exports: [SharedConsumer] })
class SecondModule {}
@Module({ imports: [FirstModule] })
class ImportingModule {}
const FACTORY = 'FactoryConsumer';

@Module({
  providers: [
    {
      provide: FACTORY,
      inject: [LoggerService],
      useFactory: (logger: LoggerService): { logger: LoggerService } => ({ logger }),
    },
  ],
})
class FactoryModule {}

describe('Automatic logger ownership', (): void => {
  afterEach((): ReturnType<typeof jest.restoreAllMocks> => jest.restoreAllMocks());

  it('distinguishes duplicate registrations, imports and factory consumers', async (): Promise<void> => {
    const module = await Test.createTestingModule({
      imports: [LoggerModule.forRoot(), FirstModule, SecondModule, ImportingModule, FactoryModule],
    }).compile();

    const { init: moduleInit2 } = module;

    await moduleInit2.bind(module)();
    const stdout = jest.spyOn(process.stdout, 'write').mockReturnValue(true);
    const { select: moduleSelect } = module;
    const first = moduleSelect.bind(module)(FirstModule).get(SharedConsumer, { strict: true });
    const { select: moduleSelect2 } = module;
    const second = moduleSelect2.bind(module)(SecondModule).get(SharedConsumer, { strict: true });
    const { get: moduleGet4 } = module;
    const factory = moduleGet4.bind(module)<{ logger: LoggerService }>(FACTORY);

    await Promise.all([
      (async () => {
        await Promise.resolve();

        return first.logger.log('First');
      })(),
      (async () => {
        await Promise.resolve();

        return second.logger.log('Second');
      })(),
      (async () => {
        await Promise.resolve();

        return factory.logger.log('Factory');
      })(),
    ]);
    const records = stdout.mock.calls.map((call): void => JSON.parse(call[0] as string));

    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: 'First',
          module: 'FirstModule',
          context: 'SharedConsumer',
        }),
        expect.objectContaining({
          message: 'Second',
          module: 'SecondModule',
          context: 'SharedConsumer',
        }),
        expect.objectContaining({ message: 'Factory', module: 'FactoryModule', context: FACTORY }),
      ]),
    );
    expect(first.logger).not.toBe(second.logger);
    const { close: moduleClose3 } = module;

    await moduleClose3.bind(module)();
  });
});
