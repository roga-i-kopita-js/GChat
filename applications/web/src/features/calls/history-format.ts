import type { CallHistoryItemDto } from '@gchat/backend-api';

export function historyDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  return (
    (hours ? hours + ':' + String(minutes).padStart(2, '0') : String(minutes)) +
    ':' +
    String(seconds % 60).padStart(2, '0')
  );
}

export function historyLabel(item: CallHistoryItemDto): string {
  const labels = {
    missed: 'Пропущенный',
    unanswered: 'Нет ответа',
    cancelled: 'Отменённый',
    rejected: 'Отклонённый',
    failed: 'Не удалось соединиться',
    completed: item.direction === 'incoming' ? 'Входящий' : 'Исходящий',
  };

  return labels[item.outcome];
}

export function historyDay(value: string, now = new Date()): string {
  const date = new Date(value);
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  if (date.toDateString() === day.toDateString()) {
    return 'Сегодня';
  }

  day.setDate(day.getDate() - 1);

  if (date.toDateString() === day.toDateString()) {
    return 'Вчера';
  }

  return date.toLocaleDateString('ru', {
    day: 'numeric',
    month: 'long',
    ...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
  });
}

export function historyTime(value: string): string {
  return new Date(value).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
}
