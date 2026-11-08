import { createHash, randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';

import { ErrorService } from '../error/error.service.js';
import type { AuthIdentity } from './auth.guard.js';
import { authSessions, authWsTickets } from './auth.schema.js';
import { AuthSessions } from './auth.sessions.js';
import { BrowserOrigin } from './browser-origin.js';

export interface WsTicket {
  ticket: string;
  expires_at: string;
}

const digest = (ticket: string): string => createHash('sha256').update(ticket).digest('hex');

@Injectable()
export class AuthWsTickets {
  constructor(
    private readonly sessions: AuthSessions,
    private readonly origins: BrowserOrigin,
    private readonly error: ErrorService,
  ) {}

  async issue(identity: AuthIdentity, origin: string | undefined): Promise<WsTicket> {
    const allowed = this.origins.assert(origin);

    return this.sessions.transaction(
      async (tx): Promise<{ ticket: string; expires_at: string }> => {
        const account = await this.sessions.lockAccount(tx, identity.userId);
        const session = await this.sessions.read(identity.sessionId, tx, true);

        if (!account || account.disabledAt || session?.userId !== account.id) {
          throw this.error.sessionInvalid();
        }

        const now = await this.sessions.now(tx);
        const start = session.wsTicketWindowStartedAt;
        const sameWindow = start && now.getTime() < start.getTime() + 60000;

        if (sameWindow && session.wsTicketCount >= 10) {
          throw this.error.rateLimited({
            retryAfterSeconds: Math.max(
              1,
              Math.ceil((start.getTime() + 60000 - now.getTime()) / 1000),
            ),
          });
        }

        const expires = new Date(now.getTime() + 30000);

        for (let attempt = 0; attempt < 5; attempt++) {
          const ticket = randomBytes(32).toString('base64url');
          const rows = await tx
            .insert(authWsTickets)
            .values({
              ticketHash: digest(ticket),
              sessionId: session.id,
              origin: allowed,
              issuedAt: now,
              expiresAt: expires,
            })
            .onConflictDoNothing()
            .returning({ id: authWsTickets.ticketHash });

          if (!rows.length) {
            continue;
          }

          await tx
            .update(authSessions)
            .set({
              wsTicketWindowStartedAt: sameWindow ? start : now,
              wsTicketCount: sameWindow ? session.wsTicketCount + 1 : 1,
            })
            .where(eq(authSessions.id, session.id));

          return { ticket, expires_at: expires.toISOString() };
        }

        throw this.error.serviceUnavailable();
      },
    );
  }

  async redeem(ticket: string, origin: string | undefined): Promise<AuthIdentity> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(ticket)) {
      throw this.error.accessTokenInvalid();
    }

    // Commit consumption before any Origin/access checks, even when they fail.
    const row = await this.sessions.transaction(
      async (tx): Promise<{ sessionId: string; origin: string; expiresAt: Date; now: Date }> =>
        (
          await tx
            .delete(authWsTickets)
            .where(eq(authWsTickets.ticketHash, digest(ticket)))
            .returning({
              sessionId: authWsTickets.sessionId,
              origin: authWsTickets.origin,
              expiresAt: authWsTickets.expiresAt,
              now: sql<Date>`clock_timestamp()`,
            })
        )[0],
    );

    if (!row || row.expiresAt <= new Date(row.now)) {
      throw this.error.accessTokenInvalid();
    }

    const allowed = this.origins.assert(origin);

    if (row.origin !== allowed) {
      throw this.error.forbidden();
    }

    const session = await this.sessions.read(row.sessionId);

    if (!session) {
      throw this.error.sessionInvalid();
    }

    const state = await this.sessions.access(session.userId, row.sessionId);

    if (!state || state.account.disabledAt || !state.session) {
      throw this.error.sessionInvalid();
    }

    return {
      userId: state.account.id,
      sessionId: row.sessionId,
      login: state.account.login,
      displayName: state.account.displayName,
      role: state.account.role,
    };
  }
}
