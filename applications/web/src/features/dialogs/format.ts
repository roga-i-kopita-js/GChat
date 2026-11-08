export function time(value: string): string {
  return new Date(value).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
}
