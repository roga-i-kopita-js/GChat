import { Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { jest } from '@jest/globals';
import { LoggerSettings, parseLogRedaction } from './logger-settings.js';
import { LoggerModule } from './logger.module.js';
import { LoggerService } from './logger.service.js';

@Injectable()
class Consumer {
  constructor(readonly logger: LoggerService) {}
}
@Module({ providers: [Consumer] })
class ConsumerModule {}

describe('LoggerService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('does not register providers on a bare module import', async () => {
    const module = await Test.createTestingModule({ imports: [LoggerModule] }).compile();
    await module.init();
    expect(() => module.get(LoggerService)).toThrow();
    expect(() => module.get(LoggerSettings)).toThrow();
    await module.close();
  });

  it('is injected globally into a separate module', async () => {
    const module = await Test.createTestingModule({ imports: [LoggerModule.forRoot(), ConsumerModule] }).compile();
    expect(module.get(Consumer).logger).toBeInstanceOf(LoggerService);
    await module.close();
  });

  it('writes one JSON record per event and routes errors to stderr', () => {
    const stdout = jest.spyOn(process.stdout, 'write').mockReturnValue(true);
    const stderr = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
    const logger = new LoggerService();
    logger.log('Started\nwith newline', { port: 3000 }, 'Bootstrap');
    logger.error('Failed', undefined, 'Redis');
    const line = stdout.mock.calls[0]![0] as string;
    expect(line.split('\n')).toHaveLength(2);
    expect(JSON.parse(line)).toMatchObject({
      timestamp: expect.any(String), level: 'info', service: 'gchat-backend',
      context: 'Bootstrap', message: 'Started\nwith newline', metadata: [{ port: 3000 }],
    });
    expect(JSON.parse(stderr.mock.calls[0]![0] as string)).toMatchObject({ level: 'error', context: 'Redis' });
  });

  it('redacts nested secrets, credentials, tokens and arbitrary driver errors', () => {
    const stdout = jest.spyOn(process.stdout, 'write').mockReturnValue(true);
    const stderr = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
    const logger = new LoggerService();
    logger.warn('Connect redis://user:private-url@host password=private-pass Bearer private-bearer', {
      nested: { refresh_token: 'private-refresh', authorization: 'private-auth', privateKey: 'private-key' },
      error: new Error('private-driver'),
      database_url: 'private-db', headers: { x: 'private-header' },
    }, 'Redis');
    logger.error(new Error('private-error'), 'private-stack', 'Bootstrap');
    const records = String(stdout.mock.calls[0]![0]) + String(stderr.mock.calls[0]![0]);
    expect(records).not.toContain('private-');
    expect(records).toContain('[REDACTED]');
    expect(records).toContain('[REDACTED_URL]');
  });

  it('handles cycles, bigint, depth and getters without serializing unsafe objects', () => {
    const stdout = jest.spyOn(process.stdout, 'write').mockReturnValue(true);
    const getter = jest.fn(() => 'private-getter');
    const data: Record<string, unknown> = { value: 123n };
    data.self = data;
    Object.defineProperty(data, 'computed', { enumerable: true, get: getter });
    Object.defineProperty(data, 'toJSON', { enumerable: true, value: () => { throw new Error('unsafe'); } });
    new LoggerService().debug('Details', data, 'Test');
    expect(getter).not.toHaveBeenCalled();
    expect(JSON.parse(stdout.mock.calls[0]![0] as string)).toMatchObject({
      metadata: [{ value: '123', self: '[Circular]', computed: '[Accessor]', toJSON: '[Unsupported]' }],
    });
  });

  it('disables masking while preserving serialization safety', () => {
    const stdout = jest.spyOn(process.stdout, 'write').mockReturnValue(true);
    const settings = { redactionEnabled: false } as LoggerSettings;
    const data: Record<string, unknown> = { password: 'visible-password', error: new Error('visible-error') };
    data.self = data;
    new LoggerService(settings).log('redis://user:password@host', data);
    const record = JSON.parse(stdout.mock.calls[0]![0] as string);
    expect(record.message).toBe('redis://user:password@host');
    expect(record.metadata[0]).toMatchObject({ password: 'visible-password', error: { message: 'visible-error' }, self: '[Circular]' });
  });

  it('validates redaction configuration explicitly', () => {
    expect(parseLogRedaction(undefined)).toBe(true);
    expect(parseLogRedaction('true')).toBe(true);
    expect(parseLogRedaction('false')).toBe(false);
    for (const value of ['', '1', 'TRUE', 'no', 0]) expect(() => parseLogRedaction(value)).toThrow();
  });

  it('does not propagate output failures into business code', () => {
    jest.spyOn(process.stderr, 'write').mockImplementation(() => { throw new Error('stream failure'); });
    expect(() => new LoggerService().error('Failed', 'Test')).not.toThrow();
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
@Module({ providers: [{ provide: FACTORY, inject: [LoggerService], useFactory: (logger: LoggerService) => ({ logger }) }] })
class FactoryModule {}

describe('Automatic logger ownership', () => {
  afterEach(() => jest.restoreAllMocks());

  it('distinguishes duplicate registrations, imports and factory consumers', async () => {
    const module = await Test.createTestingModule({
      imports: [LoggerModule.forRoot(), FirstModule, SecondModule, ImportingModule, FactoryModule],
    }).compile();
    await module.init();
    const stdout = jest.spyOn(process.stdout, 'write').mockReturnValue(true);
    const first = module.select(FirstModule).get(SharedConsumer, { strict: true });
    const second = module.select(SecondModule).get(SharedConsumer, { strict: true });
    const factory = module.get<{ logger: LoggerService }>(FACTORY);
    await Promise.all([
      Promise.resolve().then(() => first.logger.log('First')),
      Promise.resolve().then(() => second.logger.log('Second')),
      Promise.resolve().then(() => factory.logger.log('Factory')),
    ]);
    const records = stdout.mock.calls.map((call) => JSON.parse(call[0] as string));
    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: 'First', module: 'FirstModule', context: 'SharedConsumer' }),
      expect.objectContaining({ message: 'Second', module: 'SecondModule', context: 'SharedConsumer' }),
      expect.objectContaining({ message: 'Factory', module: 'FactoryModule', context: FACTORY }),
    ]));
    expect(first.logger).not.toBe(second.logger);
    await module.close();
  });
});
