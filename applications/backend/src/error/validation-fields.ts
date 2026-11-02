import type { ValidationError } from 'class-validator';

import type { ErrorField } from './app.error.js';

const codes: Record<string, string> = {
  isDefined: 'REQUIRED',
  isNotEmpty: 'REQUIRED',
  minLength: 'TOO_SHORT',
  maxLength: 'TOO_LONG',
  isLength: 'INVALID_LENGTH',
};

export function validationFields(errors: ValidationError[], parent = ''): ErrorField[] {
  return errors.flatMap((error): ErrorField[] => {
    const field = parent ? `${parent}.${error.property}` : error.property;
    // Unknown input property names are not echoed back.
    const own = Object.keys(error.constraints ?? {})
      .filter((constraint): boolean => constraint !== 'whitelistValidation' && Boolean(field))
      .map((constraint): ErrorField => ({ field, code: codes[constraint] ?? 'INVALID_FORMAT' }));

    return [
      ...new Map(own.map((item): [string, ErrorField] => [item.code, item])).values(),
      ...validationFields(error.children ?? [], field),
    ];
  });
}
