import { ClientError } from '../api/client';
import { request } from '../session/session';
import { wireSchema } from './protocol';

interface Pending {
  resolve: (payload: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class Signaling {
  private socket: WebSocket | null = null;
  private pending = new Map<string, Pending>();

  constructor(
    private readonly event: (type: string, payload: unknown) => void,
    private readonly disconnected: (code: number) => void,
  ) {}

  async open(): Promise<void> {
    const { ticket } = await request((api): ReturnType<typeof api.authWsTicket> =>
      api.authWsTicket({ body: {} }),
    );
    const url = new URL('/ws', location.href);

    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url, ['gchat', 'ticket.' + ticket]);

    this.socket = socket;
    socket.onmessage = (message): void => {
      try {
        const wire = wireSchema.parse(JSON.parse(String(message.data)));

        if (wire.type === 'response' && wire.request_id) {
          const operation = this.pending.get(wire.request_id);

          if (!operation) {
            return;
          }

          clearTimeout(operation.timer);
          this.pending.delete(wire.request_id);

          if (wire.error) {
            operation.reject(new ClientError(wire.error.code, wire.error.message));
          } else {
            operation.resolve(wire.payload);
          }
        } else {
          this.event(wire.type, wire.payload);
        }
      } catch {
        socket.close(1008);
      }
    };
    socket.onclose = (event): void => {
      for (const operation of this.pending.values()) {
        clearTimeout(operation.timer);
        operation.reject(new ClientError('DISCONNECTED', 'Связь с сервером потеряна'));
      }

      this.pending.clear();

      if (this.socket === socket) {
        this.socket = null;
        this.disconnected(event.code);
      }
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
        reject(new Error('Не удалось подключиться к серверу'));
      };
    });
  }

  send(type: string, payload: object): Promise<unknown> {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      return Promise.reject(new ClientError('DISCONNECTED', 'Нет подключения к серверу'));
    }

    const id = crypto.randomUUID();

    return new Promise((resolve, reject): void => {
      const timer = setTimeout((): void => {
        this.pending.delete(id);
        reject(
          new ClientError(
            'TIMEOUT',
            'Не удалось подтвердить действие. Получаем актуальное состояние.',
          ),
        );
      }, 10000);

      this.pending.set(id, { resolve, reject, timer });
      this.socket!.send(JSON.stringify({ type, request_id: id, payload }));
    });
  }

  close(): void {
    const socket = this.socket;

    this.socket = null;
    socket?.close(1000);

    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new ClientError('DISCONNECTED', 'Соединение закрыто'));
    }

    this.pending.clear();
  }
}
