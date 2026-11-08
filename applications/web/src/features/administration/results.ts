import type { Credentials } from './CredentialsDialog';

export class AdminResults {
  private listeners = new Set<(value: Credentials, sid: string) => void>();

  subscribe(listener: (value: Credentials, sid: string) => void): () => void {
    this.listeners.add(listener);

    return (): void => {
      this.listeners.delete(listener);
    };
  }

  publish(value: Credentials, sid: string): void {
    for (const listener of this.listeners) {
      listener(value, sid);
    }
  }
}
