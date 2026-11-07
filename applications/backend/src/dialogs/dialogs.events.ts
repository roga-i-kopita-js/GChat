import { Injectable } from '@nestjs/common';

import type { MessageDto } from './dialogs.dto.js';

export type DialogEvent =
  | { type: 'dialog.messages_available'; payload: { dialog_id: string; last_sequence: number } }
  | {
      type: 'dialog.read_updated';
      payload: { dialog_id: string; reader_id: string; last_read_sequence: number };
    };

export interface DialogNotice {
  users: string[];
  event: DialogEvent;
  message?: MessageDto;
}

@Injectable()
export class DialogsEvents {
  private readonly listeners = new Set<(notice: DialogNotice) => Promise<void>>();

  subscribe(listener: (notice: DialogNotice) => Promise<void>): () => void {
    this.listeners.add(listener);

    return (): void => {
      this.listeners.delete(listener);
    };
  }

  publish(notice: DialogNotice): void {
    for (const listener of this.listeners)
      void Promise.resolve()
        .then((): Promise<void> => listener(notice))
        .catch((): void => {});
  }
}
