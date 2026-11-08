import { z } from 'zod';

export const contactsQuerySchema = z.object({
  group: z
    .union([z.uuid(), z.literal('all')])
    .optional()
    .catch(undefined),
});
