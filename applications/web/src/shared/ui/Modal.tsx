import './Modal.css';

import { X } from 'lucide-react';
import type { JSX, ReactNode } from 'react';
import { useEffect, useRef } from 'react';

import { Button } from './Button';
import { Text } from './Text';

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
    <dialog
      ref={ref}
      onCancel={(event): void => {
        event.preventDefault();
        close();
      }}
      className="modal"
      aria-label={title}
    >
      <Button
        variant="ghost"
        size="icon"
        className="icon close"
        aria-label="Закрыть"
        onClick={close}
      >
        <X className="ui-modal-close-icon" />
      </Button>
      <Text as="h2" variant="heading">
        {title}
      </Text>
      {children}
    </dialog>
  );
}
