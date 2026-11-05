import { z } from 'zod';

const claims = z.object({
  sub: z.string(),
  role: z.enum(['user', 'admin']).default('user'),
  sid: z.string(),
  login: z.string(),
  display_name: z.string(),
  iat: z.number(),
  exp: z.number(),
});

/** Display claims only; backend remains the authority for identity and permissions. */
export function identity(session: { access_token: string }): z.infer<typeof claims> {
  const part = session.access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
  const bytes = Uint8Array.from(atob(part), (char): number => char.charCodeAt(0));

  return claims.parse(JSON.parse(new TextDecoder().decode(bytes)));
}
