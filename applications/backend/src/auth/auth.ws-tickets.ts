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

        const { disabledAt: accountDisabledAt } = account ?? {};
        const { userId: sessionUserId } = session ?? {};
        const { id: accountId } = account ?? {};

        if (!account || accountDisabledAt || !session || sessionUserId !== accountId) {
          throw this.error.sessionInvalid();
        }

        const now = await this.sessions.now(tx);
        const { wsTicketWindowStartedAt: sessionWsTicketWindowStartedAt } = session;
        const start = sessionWsTicketWindowStartedAt;
        const { getTime: nowGetTime } = now;
        const sameWindow = start && nowGetTime.bind(now)() < start.getTime() + 60000;

        const { wsTicketCount: sessionWsTicketCount } = session;

        if (sameWindow && sessionWsTicketCount >= 10) {
          const { getTime: nowGetTime2 } = now;

          throw this.error.rateLimited({
            retryAfterSeconds: Math.max(
              1,
              Math.ceil((start.getTime() + 60000 - nowGetTime2.bind(now)()) / 1000),
            ),
          });
        }

        const { getTime: nowGetTime3 } = now;
        const expires = new Date(nowGetTime3.bind(now)() + 30000);

        for (let attempt = 0; attempt < 5; attempt++) {
          const ticket = randomBytes(32).toString('base64url');
          const { id: sessionId2 } = session;
          const rows = await tx
            .insert(authWsTickets)
            .values({
              ticketHash: digest(ticket),
              sessionId: sessionId2,
              origin: allowed,
              issuedAt: now,
              expiresAt: expires,
            })
            .onConflictDoNothing()
            .returning({ id: authWsTickets.ticketHash });

          const { length: rowsLength } = rows ?? {};

          if (!rowsLength) {
            continue;
          }

          const { wsTicketCount: sessionWsTicketCount2, id: sessionId3 } = session;

          await tx
            .update(authSessions)
            .set({
              wsTicketWindowStartedAt: sameWindow ? start : now,
              wsTicketCount: sameWindow ? sessionWsTicketCount2 + 1 : 1,
            })
            .where(eq(authSessions.id, sessionId3));

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
      async (tx): Promise<{ sessionId: string; origin: string; expiresAt: Date; now: Date }> => {
        const { [0]: returningResultFirst } = await tx
          .delete(authWsTickets)
          .where(eq(authWsTickets.ticketHash, digest(ticket)))
          .returning({
            sessionId: authWsTickets.sessionId,
            origin: authWsTickets.origin,
            expiresAt: authWsTickets.expiresAt,
            now: sql<Date>`clock_timestamp()`,
          });

        return returningResultFirst;
      },
    );

    const { expiresAt: rowExpiresAt, now: rowNow } = row ?? {};

    if (!row || rowExpiresAt <= new Date(rowNow)) {
      throw this.error.accessTokenInvalid();
    }

    const allowed = this.origins.assert(origin);

    const { origin: rowOrigin } = row;

    if (rowOrigin !== allowed) {
      throw this.error.forbidden();
    }

    const { sessionId: rowSessionId } = row;
    const session = await this.sessions.read(rowSessionId);

    if (!session) {
      throw this.error.sessionInvalid();
    }

    const { userId: sessionUserId2 } = session;
    const { sessionId: rowSessionId2 } = row;
    const state = await this.sessions.access(sessionUserId2, rowSessionId2);

    const { account: stateAccount, session: stateSession } = state ?? {};

    if (!stateAccount || stateAccount.disabledAt || !stateSession) {
      throw this.error.sessionInvalid();
    }

    const { sessionId: rowSessionId3 } = row;

    return {
      userId: stateAccount.id,
      sessionId: rowSessionId3,
      login: stateAccount.login,
      displayName: stateAccount.displayName,
      role: stateAccount.role,
    };
  }
}
