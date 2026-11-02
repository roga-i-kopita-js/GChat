import { LoggerModule } from '../src/logger/logger.module.js';
import { Body, Controller, Get, HttpException, Injectable, Module, Post } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { IsDefined, IsString, MinLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import request from 'supertest';
import { ErrorModule } from '../src/error/error.module.js';
import { ErrorService } from '../src/error/error.service.js';

class ProfileDto {
  @IsString()
  @MinLength(3)
  login!: string;
}

class InputDto {
  @IsDefined()
  @ValidateNested()
  @Type(() => ProfileDto)
  profile!: ProfileDto;
}

@Injectable()
class ConsumerService {
  constructor(private readonly error: ErrorService) {}

  limited(): never {
    throw this.error.rateLimited({ retryAfterSeconds: 42, cause: new Error('secret-driver') });
  }

  expired(): never {
    throw this.error.accessTokenExpired();
  }
}

@Controller('auth/test-errors')
class ConsumerController {
  constructor(private readonly service: ConsumerService) {}

  @Get('limited') limited() { return this.service.limited(); }
  @Get('expired') expired() { return this.service.expired(); }
  @Get('unexpected') unexpected() { throw new Error('postgres://secret'); }
  @Get('http') http() { throw new HttpException({ message: 'secret-http', token: 'secret-token' }, 409); }
  @Post('input') input(@Body() body: InputDto) { return body; }
}

// Does not import ErrorModule: exercises global DI in a separate consumer module.
@Module({ controllers: [ConsumerController], providers: [ConsumerService] })
class ConsumerModule {}

describe('Global ErrorModule HTTP contract', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [LoggerModule.forRoot(), ErrorModule, ConsumerModule] }).compile();
    app = module.createNestApplication();
    await app.init();
  });
  afterAll(async () => { await app?.close(); });

  it('catches an injected service factory error and preserves retry and cache headers', async () => {
    await request(app.getHttpServer()).get('/auth/test-errors/limited')
      .expect(429).expect('Retry-After', '42').expect('Cache-Control', 'no-store')
      .expect({ error: { code: 'RATE_LIMITED', message: 'Слишком много попыток. Попробуйте позже.' } });
  });

  it('returns the expired access code directly from a service', async () => {
    await request(app.getHttpServer()).get('/auth/test-errors/expired').expect(401)
      .expect({ error: { code: 'ACCESS_TOKEN_EXPIRED', message: 'Срок действия токена истёк.' } });
  });

  it('hides unknown exceptions and arbitrary HTTP exception bodies', async () => {
    await request(app.getHttpServer()).get('/auth/test-errors/unexpected').expect(500)
      .expect({ error: { code: 'INTERNAL_ERROR', message: 'Внутренняя ошибка сервера.' } });
    await request(app.getHttpServer()).get('/auth/test-errors/http').expect(409)
      .expect({ error: { code: 'HTTP_ERROR', message: 'Ошибка HTTP-запроса.' } });
  });

  it('validates nested DTOs with field codes without echoing input values', async () => {
    await request(app.getHttpServer()).post('/auth/test-errors/input').send({ profile: { login: 'x' } })
      .expect(400).expect({ error: {
        code: 'VALIDATION_ERROR', message: 'Проверьте введённые данные.',
        fields: [{ field: 'profile.login', code: 'TOO_SHORT' }],
      } });
    await request(app.getHttpServer()).post('/auth/test-errors/input').send({ profile: { login: 'valid' } })
      .expect(201).expect({ profile: { login: 'valid' } });
  });

  it('rejects unknown properties without reflecting their names or values', async () => {
    await request(app.getHttpServer()).post('/auth/test-errors/input')
      .send({ profile: { login: 'valid' }, 'secret-field': 'secret-value' }).expect(400)
      .expect({ error: { code: 'VALIDATION_ERROR', message: 'Проверьте введённые данные.' } });
  });

  it('normalizes malformed JSON and unknown routes', async () => {
    await request(app.getHttpServer()).post('/auth/test-errors/input')
      .set('Content-Type', 'application/json').send('{"password":"secret"').expect(400)
      .expect({ error: { code: 'VALIDATION_ERROR', message: 'Проверьте введённые данные.' } });
    await request(app.getHttpServer()).get('/missing').expect(404)
      .expect({ error: { code: 'NOT_FOUND', message: 'Ресурс не найден.' } });
  });

  it('creates independent errors and prevents fixed factory codes being overwritten', () => {
    const error = app.get(ErrorService);
    const payload = { retryAfterSeconds: 3, code: 'FORGED', status: 200, message: 'Safe' };
    const first = error.rateLimited(payload);
    expect(first).toMatchObject({ status: 429, code: 'RATE_LIMITED', message: 'Safe' });
    expect(error.rateLimited(payload)).not.toBe(first);
    expect(() => error.rateLimited({ retryAfterSeconds: -1 })).toThrow(RangeError);
  });
});
