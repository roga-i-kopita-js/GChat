import { z } from 'zod';

/** Preserve duplicate fields so scalar schemas cannot silently accept the last value. */
function fields(entries: Iterable<[string, unknown]>): Record<string, unknown> {
  const result: Record<string, unknown> = Object.create(null);

  for (const [key, value] of entries) {
    if (Object.hasOwn(result, key)) {
      const previous: unknown = result[key];

      result[key] = Array.isArray(previous) ? [...previous, value] : [previous, value];
    } else {
      result[key] = value;
    }
  }

  return result;
}
const queryFields = z.instanceof(URLSearchParams).transform(fields);
const formFields = z.instanceof(FormData).transform(fields);

export function readQuery<T>(schema: z.ZodType<T>, request: Request): T {
  const { query } = z
    .object({ method: z.enum(['GET', 'HEAD']), query: queryFields })
    .parse({ method: request.method, query: new URL(request.url).searchParams });

  return schema.parse(query);
}

export async function readForm<T>(schema: z.ZodType<T>, request: Request): Promise<T> {
  request.signal.throwIfAborted();
  const body = await (async () => {
    try {
      return await request.formData();
    } catch (cause) {
      return undefined;
    }
  })();

  request.signal.throwIfAborted();
  const parsed = z
    .object({ method: z.literal('POST'), body: formFields })
    .parse({ method: request.method, body });

  return schema.parse(parsed.body);
}

export function readFields<T>(schema: z.ZodType<T>, form: FormData): T {
  return schema.parse(formFields.parse(form));
}
