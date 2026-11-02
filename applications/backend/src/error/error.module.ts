import { Global, Module, ValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import { ErrorFilter } from './error.filter.js';
import { ErrorService } from './error.service.js';
import { validationFields } from './validation-fields.js';

@Global()
@Module({
  providers: [
    ErrorService,
    { provide: APP_FILTER, useClass: ErrorFilter },
    {
      provide: APP_PIPE,
      inject: [ErrorService],
      useFactory: (error: ErrorService) => new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
        validationError: { target: false, value: false },
        exceptionFactory: (errors) => error.validation({ fields: validationFields(errors) }),
      }),
    },
  ],
  exports: [ErrorService],
})
export class ErrorModule {}
