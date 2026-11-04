import type { JSX, ReactNode } from 'react';
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

export function CallSurface({
  incoming,
  children,
}: {
  incoming: boolean;
  children: ReactNode;
}): JSX.Element {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect((): (() => void) | undefined => {
    if (!incoming) return;

    const dialog = ref.current;

    dialog?.showModal();

    return (): void => dialog?.close();
  }, [incoming]);

  return incoming ? (
    createPortal(
      <dialog
        ref={ref}
        className="incoming-call-modal"
        aria-label="Входящий звонок"
        onCancel={(event): void => event.preventDefault()}
      >
        {children}
      </dialog>,
      document.body,
    )
  ) : (
    <>{children}</>
  );
}
