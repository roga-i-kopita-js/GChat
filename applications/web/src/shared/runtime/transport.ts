import { z } from 'zod';

import { ClientError, retryAfter } from '../api/client';
import { prepareUpdate, updateChannel, updateLock, updateRequested } from '../pwa-update';

interface Dependencies {
  session(): { sessionId: string; deviceId: string | null } | null;
  ticket(): Promise<string>;
  bind(sessionId: string, deviceId: string): void;
}
interface TransportState {
  owner: boolean;
  status: 'offline' | 'connecting' | 'online';
  generation: number;
  error: unknown;
}
const wire = z.object({
  type: z.string(),
  request_id: z.string().optional(),
  payload: z.unknown().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/** Owns the single browser connection. Call and dialog engines are consumers. */
export class BrowserTransport {
  private dependencies?: Dependencies;
  private state: TransportState = { owner: false, status: 'offline', generation: 0, error: null };
  private listeners = new Set<() => void>();
  private messages = new Set<(type: string, payload: unknown) => void>();
  private guards = new Set<() => boolean>();
  private socket: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private controller?: AbortController;
  private release?: () => void;
  private sid: string | null = null;
  private running = false;
  private updatePending = false;
  private retry?: ReturnType<typeof setTimeout>;
  private retries = 0;
  private channel?: BroadcastChannel;

  configure(dependencies: Dependencies): void {
    this.dependencies = dependencies;
  }

  getSnapshot = (): TransportState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);

    return (): void => {
      this.listeners.delete(listener);
    };
  };

  subscribeMessage(listener: (type: string, payload: unknown) => void): () => void {
    this.messages.add(listener);

    return (): void => {
      this.messages.delete(listener);
    };
  }

  protect(guard: () => boolean): () => void {
    this.guards.add(guard);

    return (): void => {
      this.guards.delete(guard);
      this.checkUpdate();
    };
  }

  private set(patch: Partial<TransportState>): void {
    this.state = { ...this.state, ...patch };

    for (const listener of this.listeners) {
      listener();
    }
  }

  private canRelease(): boolean {
    return [...this.guards].every((guard): boolean => guard());
  }

  private checkUpdate = (): void => {
    if (this.updatePending && this.release && this.canRelease()) {
      this.yield();
    }
  };

  changed(): void {
    this.checkUpdate();
  }

  isUpdating(): boolean {
    return this.updatePending;
  }

  activate(): void {
    this.channel?.postMessage('takeover');
  }

  private yield(): void {
    const release = this.release;

    this.release = undefined;
    this.closeSocket();
    release?.();
  }

  private prepare = (): void => {
    this.updatePending = true;
    this.checkUpdate();
  };

  start(): () => void {
    if (this.running) {
      throw new Error('Browser transport already started');
    }

    this.running = true;
    this.channel = new BroadcastChannel('gchat-transport');
    this.channel.onmessage = (event: MessageEvent<unknown>): void => {
      if (event.data === 'takeover' && this.state.owner && this.canRelease()) {
        this.yield();
      }
    };
    const updates = new BroadcastChannel(updateChannel);

    updates.onmessage = (event: MessageEvent<unknown>): void => {
      if (event.data === 'prepare') {
        this.prepare();
      }
    };
    const monitor = setInterval((): void => {
      if (this.updatePending) {
        void updateRequested().then((pending): void => {
          if (!pending) {
            this.updatePending = false;
          }
        });
      }
    }, 1000);

    window.addEventListener(prepareUpdate, this.prepare);
    window.addEventListener('gchat-session', this.sync);
    window.addEventListener('storage', this.sync);
    window.addEventListener('pagehide', this.yieldOnHide);
    this.sync();

    return (): void => {
      this.running = false;
      this.controller?.abort();
      this.yield();
      this.sid = null;
      updates.close();
      this.channel?.close();
      clearInterval(monitor);
      window.removeEventListener(prepareUpdate, this.prepare);
      window.removeEventListener('gchat-session', this.sync);
      window.removeEventListener('storage', this.sync);
      window.removeEventListener('pagehide', this.yieldOnHide);
    };
  }

  private yieldOnHide = (): void => {
    this.yield();
  };
  private sync = (): void => {
    const sid = this.dependencies?.session()?.sessionId ?? null;

    if (sid === this.sid) {
      return;
    }

    this.controller?.abort();
    this.yield();
    this.sid = sid;

    if (sid) {
      this.elect(sid);
    }
  };

  private elect(sid: string): void {
    if (!this.running || sid !== this.sid) {
      return;
    }

    const controller = new AbortController();

    this.controller = controller;
    void navigator.locks
      .request('gchat-ws-owner', { signal: controller.signal }, async (): Promise<void> => {
        if (sid !== this.sid || !this.running) {
          return;
        }

        await navigator.locks.request(
          updateLock,
          { mode: 'shared', signal: controller.signal },
          async (): Promise<void> => {
            if (sid !== this.sid || !this.running) {
              return;
            }

            this.updatePending = false;
            const lifetime = new Promise<void>((resolve): void => {
              this.release = resolve;
            });

            this.set({ owner: true });
            void this.connect();
            await lifetime;
            this.release = undefined;
            this.closeSocket();
            this.set({ owner: false });
          },
        );
      })
      .catch((): void => {})
      .finally((): void => {
        if (this.running && sid === this.sid && !controller.signal.aborted) {
          this.retry = setTimeout((): void => this.elect(sid), 250);
        }
      });
  }

  reconnect(seconds = 0): void {
    clearTimeout(this.retry);

    if (!this.state.owner || !this.sid || this.updatePending) {
      return;
    }

    this.retry = setTimeout(
      (): void => {
        void this.connect();
      },
      Math.max(seconds * 1000, Math.min(10000, 1000 * 2 ** Math.min(4, this.retries++))),
    );
  }

  private async connect(): Promise<void> {
    this.closeSocket();
    const generation = this.state.generation;
    const sid = this.sid;
    const dependencies = this.dependencies;

    if (!dependencies || !sid || !this.state.owner) {
      return;
    }

    this.set({ status: 'connecting', error: null });

    try {
      const ticket = await dependencies.ticket();

      if (generation !== this.state.generation || sid !== this.sid) {
        return;
      }

      const url = new URL('/ws', location.href);

      url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(url, ['gchat', 'ticket.' + ticket]);

      this.socket = socket;
      socket.onmessage = (event): void => {
        if (this.socket !== socket) {
          return;
        }

        try {
          const message = wire.parse(JSON.parse(String(event.data)));

          if (message.type === 'response' && message.request_id) {
            const pending = this.pending.get(message.request_id);

            if (!pending) {
              return;
            }

            clearTimeout(pending.timer);
            this.pending.delete(message.request_id);

            if (message.error) {
              pending.reject(new ClientError(message.error.code, message.error.message));
            } else {
              pending.resolve(message.payload);
            }
          } else {
            for (const listener of this.messages) {
              listener(message.type, message.payload);
            }
          }
        } catch {
          socket.close(1008);
        }
      };
      socket.onclose = (): void => {
        if (this.socket !== socket) {
          return;
        }

        this.closeSocket();
        this.reconnect();
      };
      await new Promise<void>((resolve, reject): void => {
        const timer = setTimeout((): void => {
          socket.close();
          reject(new Error('Сервер не отвечает'));
        }, 10000);

        socket.onopen = (): void => {
          clearTimeout(timer);
          resolve();
        };
        socket.onerror = (): void => {
          clearTimeout(timer);
          reject(new Error('Не удалось подключиться'));
        };
      });

      if (generation !== this.state.generation || sid !== this.sid) {
        return;
      }

      const registered = z.object({ device_id: z.string().uuid() }).parse(
        await this.send('device.register', {
          device_id: dependencies.session()?.deviceId ?? null,
        }),
      );

      if (generation !== this.state.generation || sid !== this.sid) {
        return;
      }

      dependencies.bind(sid, registered.device_id);
      this.retries = 0;
      this.set({ status: 'online', error: null });
    } catch (error) {
      if (generation !== this.state.generation || sid !== this.sid) {
        return;
      }

      this.set({ status: 'offline', error });
      this.reconnect(retryAfter(error));
    }
  }

  send(type: string, payload: object): Promise<unknown> {
    const socket = this.socket;

    if (socket?.readyState !== WebSocket.OPEN) {
      return Promise.reject(new ClientError('DISCONNECTED', 'Связь с сервером потеряна'));
    }

    const request_id = crypto.randomUUID();

    return new Promise((resolve, reject): void => {
      const timer = setTimeout((): void => {
        this.pending.delete(request_id);
        reject(new ClientError('TIMEOUT', 'Не удалось подтвердить действие'));
      }, 10000);

      this.pending.set(request_id, { resolve, reject, timer });

      try {
        socket.send(JSON.stringify({ type, request_id, payload }));
      } catch {
        clearTimeout(timer);
        this.pending.delete(request_id);
        reject(new ClientError('DISCONNECTED', 'Связь с сервером потеряна'));
      }
    });
  }

  private closeSocket(): void {
    const socket = this.socket;

    this.socket = null;
    socket?.close(1000);
    clearTimeout(this.retry);

    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new ClientError('DISCONNECTED', 'Соединение закрыто'));
    }

    this.pending.clear();
    this.set({ status: 'offline', generation: this.state.generation + 1 });
  }
}

export const browserTransport = new BrowserTransport();
