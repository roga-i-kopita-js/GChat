import { z } from 'zod';

/* oxlint-disable gchat/no-promise-chains -- Zod .catch supplies validation fallbacks, not Promise handlers. */
export const contactsQuerySchema = z.object({
  group: z
    .union([z.uuid(), z.literal('all')])
    .optional()
    .catch(undefined),
});
/* oxlint-enable gchat/no-promise-chains */
