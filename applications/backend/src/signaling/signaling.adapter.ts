import type { IncomingMessage } from 'node:http';

import type { INestApplication } from '@nestjs/common';
import { WsAdapter } from '@nestjs/platform-ws';
import type { VerifyClientCallbackAsync, WebSocketServer } from 'ws';

import type { AuthIdentity } from '../auth/auth.guard.js';
import { AuthService } from '../auth/auth.service.js';
import { AuthWsTickets } from '../auth/auth.ws-tickets.js';
import { AppError } from '../error/app.error.js';
import { ErrorService } from '../error/error.service.js';

export const wsIdentities = new WeakMap<IncomingMessage, AuthIdentity>();

export class SignalingAdapter extends WsAdapter {
  private readonly error: ErrorService;
  private readonly tickets: AuthWsTickets;

  constructor(
    app: INestApplication,
    private readonly auth: AuthService,
  ) {
    super(app, { maxConcurrentMessages: 1, maxSendBufferSize: 1048576 });
    this.error = app.get(ErrorService);
    this.tickets = app.get(AuthWsTickets);
  }

  override create(port: number, options: Record<string, unknown> = {}): WebSocketServer {
    const verifyClient: VerifyClientCallbackAsync = (info, done): void => {
      const header = info.req.headers.authorization;

      const protocols =
        info.req.headers['sec-websocket-protocol']
          ?.split(',')
          .map((value): string => value.trim()) ?? [];
      let identity: Promise<AuthIdentity>;

      try {
        if (info.req.url !== '/ws') {
          throw this.error.accessTokenInvalid();
        }

        if (header) {
          if (protocols.length) {
            throw this.error.validation();
          }

          if (!/^Bearer [^\s]+$/i.test(header)) {
            throw this.error.accessTokenInvalid();
          }

          identity = this.auth.authenticate(header.slice(7));
        } else {
          if (!protocols.length) {
            throw this.error.accessTokenInvalid();
          }

          if (protocols.length !== 2 || !protocols.includes('gchat')) {
            throw this.error.validation();
          }

          const ticket = protocols.find((value): boolean => value.startsWith('ticket.'))?.slice(7);

          if (!ticket || !/^[A-Za-z0-9_-]{43}$/.test(ticket)) {
            throw this.error.validation();
          }

          identity = this.tickets.redeem(ticket, info.req.headers.origin);
        }
      } catch (cause) {
        identity = Promise.reject(cause);
      }

      void identity
        .then((identity): void => {
          wsIdentities.set(info.req, identity);
          done(true);
        })
        .catch((cause: unknown): void => {
          const failure = cause instanceof AppError ? cause : this.error.serviceUnavailable();

          done(
            false,
            failure.status,
            JSON.stringify({ error: { code: failure.code, message: failure.message } }),
            { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
          );
        });
    };
    const server: WebSocketServer = super.create(port, {
      ...options,
      maxPayload: 131072,
      perMessageDeflate: false,
      verifyClient,
      handleProtocols: (protocols: Set<string>): string | false =>
        protocols.has('gchat') ? 'gchat' : false,
    });

    return server;
  }
}
