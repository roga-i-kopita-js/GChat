import { X } from 'lucide-react';
import type { JSX, ReactNode } from 'react';
import { useEffect, useRef } from 'react';

export { Select } from './Select';

export function Avatar({ name, large = false }: { name: string; large?: boolean }): JSX.Element {
  const colors = ['#dceaff', '#e8e2fb', '#dcf2eb', '#faeadc', '#f5e0eb'];
  const index =
    [...name].reduce((sum, char): number => sum + char.charCodeAt(0), 0) % colors.length;

  return (
    <span
      className={'avatar' + (large ? ' large' : '')}
      style={{ background: colors[index] }}
      aria-hidden="true"
    >
      {name
        .trim()
        .split(/\s+/)
        .slice(0, 2)
        .map((word): string => word[0] ?? '')
        .join('')
        .toUpperCase()}
    </span>
  );
}

export function Modal({
  title,
  children,
  close,
}: {
  title: string;
  children: ReactNode;
  close: () => void;
}): JSX.Element {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect((): void => {
    ref.current?.showModal();
  }, []);

  return (
    <dialog ref={ref} onCancel={close} className="modal" aria-label={title}>
      <button className="icon close" aria-label="Закрыть" onClick={close}>
        <X size={20} />
      </button>
      <h2>{title}</h2>
      {children}
    </dialog>
  );
}
