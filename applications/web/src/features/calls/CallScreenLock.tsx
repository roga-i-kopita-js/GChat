import './CallScreenLock.css';

import { ArrowRight, LockKeyhole } from 'lucide-react';
import type { JSX } from 'react';
import { useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export function CallScreenLock({ unlock }: { unlock: () => void }): JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const gesture = useRef<{ pointer: number; x: number; y: number; distance: number } | null>(null);
  const [offset, setOffset] = useState(0);
  const hint = useId();

  useLayoutEffect(() => {
    const element = dialog.current;

    element?.showModal();

    return () => element?.close();
  }, []);

  function reset(): void {
    gesture.current = null;
    setOffset(0);
  }

  return createPortal(
    <dialog
      ref={dialog}
      className="call-screen-lock"
      aria-label="Экран заблокирован от случайных нажатий"
      aria-describedby={hint}
      onCancel={(event) => event.preventDefault()}
      onContextMenu={(event) => event.preventDefault()}
    >
      <div className="call-screen-lock-content">
        <LockKeyhole className="call-screen-lock-icon" aria-hidden="true" />
        <p>Экран защищён от нажатий</p>
        <p id={hint}>Проведите ползунок вправо, чтобы разблокировать</p>
        <div className="call-screen-lock-track" ref={track}>
          <span aria-hidden="true">Разблокировать</span>
          <button
            type="button"
            className="call-screen-lock-thumb"
            aria-label="Разблокировать экран"
            style={{ transform: `translateX(${offset}px)` }}
            onClick={(event) => {
              // Keyboard and assistive activation remain available; a tap cannot unlock.
              if (event.detail === 0) {
                unlock();
              }
            }}
            onPointerDown={(event) => {
              if (!event.isPrimary || event.button !== 0 || !track.current) {
                return;
              }

              gesture.current = {
                pointer: event.pointerId,
                x: event.clientX,
                y: event.clientY,
                distance: track.current.clientWidth - event.currentTarget.offsetWidth,
              };
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              const start = gesture.current;

              if (!start || start.pointer !== event.pointerId) {
                return;
              }

              if (Math.abs(event.clientY - start.y) > event.currentTarget.offsetHeight) {
                reset();

                return;
              }

              setOffset(Math.max(0, Math.min(start.distance, event.clientX - start.x)));
            }}
            onPointerUp={(event) => {
              const start = gesture.current;

              reset();

              if (
                start &&
                start.pointer === event.pointerId &&
                start.distance > 0 &&
                event.clientX - start.x >= start.distance * 0.9 &&
                Math.abs(event.clientY - start.y) <= event.currentTarget.offsetHeight
              ) {
                unlock();
              }
            }}
            onPointerCancel={reset}
            onLostPointerCapture={reset}
          >
            <ArrowRight aria-hidden="true" />
          </button>
        </div>
      </div>
    </dialog>,
    document.body,
  );
}
