import { z } from 'zod';

export const accountLoginSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(32)
  .regex(/^[a-z0-9._-]+$/);

export const passwordSchema = z.string().min(15).max(128);

export const loginFormSchema = z.strictObject({
  login: accountLoginSchema,
  password: passwordSchema,
});

export const optionalLoginSchema = z
  .string()
  .trim()
  .pipe(z.union([z.literal(''), accountLoginSchema]))
  .optional()
  .transform((value): string | undefined => (value === '' ? undefined : value));
