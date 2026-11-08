import { z } from 'zod';

import { optionalLoginSchema, passwordSchema } from '../auth/request-schemas';

const search = z
  .string()
  .trim()
  .max(80)
  .regex(/^[^\x00-\x1f\x7f]*$/);

export const adminUsersQuerySchema = z.object({
  q: search.catch(''),
  status: z.enum(['all', 'active', 'disabled']).catch('all'),
  offset: z
    .string()
    .regex(/^\d+$/)
    .transform(Number)
    .pipe(z.number().int().nonnegative().safe().multipleOf(25))
    .catch(0),
});

export const adminGroupsQuerySchema = z.object({ q: search.catch('') });

export const adminUserParamsSchema = z.object({ userId: z.uuid() });

export type AdminUsersFilters = z.output<typeof adminUsersQuerySchema>;

export const adminOperationSchema = z.discriminatedUnion('operation', [
  z.strictObject({
    operation: z.literal('create'),
    display_name: z.string().trim().min(1).max(80),
    group_name: z.string().trim().min(1),
    login: optionalLoginSchema,
    password: passwordSchema,
  }),
  z.strictObject({ operation: z.literal('password'), user_id: z.uuid(), password: passwordSchema }),
  z.strictObject({ operation: z.literal('disable'), user_id: z.uuid() }),
  z.strictObject({ operation: z.literal('enable'), user_id: z.uuid() }),
]);

export type AdminOperation = z.output<typeof adminOperationSchema>;

export const adminValidationMessage =
  'Проверьте имя, группу, логин и длину пароля (15–128 символов).';
