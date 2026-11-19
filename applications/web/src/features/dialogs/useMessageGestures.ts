import type { MouseEvent, PointerEvent as ReactPointerEvent } from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

import type { DialogMessage } from '../../shared/dialogs/model';

interface Options {
  canRead: boolean;
  canReply: boolean;
  blocked: boolean;
  openMenu(message: DialogMessage, anchor: HTMLElement): void;
  reply(message: DialogMessage): void;
}

interface Gesture {
  pointerId: number;
  x: number;
  y: number;
  anchor: HTMLElement;
  container: HTMLElement;
  message: DialogMessage;
  canSwipe: boolean;
  dragging: boolean;
  offset: number;
  slop: number;
  threshold: number;
  limit: number;
  timer: ReturnType<typeof setTimeout> | null;
}

export function useMessageGestures(options: Options): {
  start(event: ReactPointerEvent<HTMLElement>, message: DialogMessage): void;
  click(event: MouseEvent<HTMLElement>): void;
  cancel(): void;
} {
  const latest = useRef(options);
  const gesture = useRef<Gesture | null>(null);
  const suppressClick = useRef(false);

  const cancel = useCallback((): void => {
    const current = gesture.current;

    gesture.current = null;

    if (!current) {
      return;
    }

    if (current.timer !== null) {
      clearTimeout(current.timer);
    }

    if (current.dragging) {
      suppressClick.current = true;
    }

    current.container.removeAttribute('data-swiping');
    current.container.removeAttribute('data-swipe-ready');
    current.container.style.removeProperty('--dialog-swipe-offset');
    current.container.style.removeProperty('--dialog-swipe-progress');

    if (current.anchor.hasPointerCapture(current.pointerId)) {
      current.anchor.releasePointerCapture(current.pointerId);
    }
  }, []);

  useLayoutEffect(() => {
    latest.current = options;

    if (options.blocked || !options.canRead || (!options.canReply && gesture.current?.dragging)) {
      cancel();
    }
  });

  useEffect(() => {
    const move = (event: PointerEvent): void => {
      const current = gesture.current;

      if (!current || event.pointerId !== current.pointerId) {
        return;
      }

      if (!current.anchor.isConnected || window.getSelection()?.toString()) {
        cancel();

        return;
      }

      const dx = event.clientX - current.x;
      const dy = event.clientY - current.y;

      // Use the same per-axis tolerance as the direction check below. A small
      // vertical drift must not reject a slow swipe before dx clears the slop.
      if (Math.max(Math.abs(dx), Math.abs(dy)) <= current.slop && !current.dragging) {
        return;
      }

      if (current.timer !== null) {
        clearTimeout(current.timer);
        current.timer = null;
      }

      if (!current.dragging) {
        if (!current.canSwipe || dx <= current.slop || dx < Math.abs(dy) * 1.5) {
          cancel();

          return;
        }

        current.dragging = true;
        current.container.setAttribute('data-swiping', 'true');
        current.anchor.setPointerCapture(current.pointerId);
      }

      if (Math.abs(dy) > Math.max(current.threshold, Math.abs(dx))) {
        cancel();

        return;
      }

      event.preventDefault();
      current.offset = Math.min(current.limit, Math.max(0, dx));
      current.container.style.setProperty('--dialog-swipe-offset', current.offset + 'px');
      current.container.style.setProperty(
        '--dialog-swipe-progress',
        String(Math.min(1, current.offset / current.threshold)),
      );
      current.container.toggleAttribute('data-swipe-ready', current.offset >= current.threshold);
    };
    const finish = (event: PointerEvent): void => {
      const current = gesture.current;

      if (!current || event.pointerId !== current.pointerId) {
        return;
      }

      const choose =
        current.dragging &&
        current.offset >= current.threshold &&
        current.anchor.isConnected &&
        latest.current.canReply &&
        !latest.current.blocked &&
        !window.getSelection()?.toString();

      cancel();

      if (choose) {
        latest.current.reply(current.message);
      }
    };
    const pointerCancelled = (event: PointerEvent): void => {
      if (event.pointerId === gesture.current?.pointerId) {
        cancel();
      }
    };
    const captureLost = (event: PointerEvent): void => {
      const current = gesture.current;

      // Moving implicit capture from a text/image child to the article is normal.
      if (
        current?.pointerId === event.pointerId &&
        (event.target === current.anchor || !current.anchor.isConnected)
      ) {
        cancel();
      }
    };
    const otherPointer = (event: PointerEvent): void => {
      if (gesture.current && event.pointerId !== gesture.current.pointerId) {
        cancel();
      }
    };
    const visibility = (): void => {
      if (document.visibilityState !== 'visible') {
        cancel();
      }
    };

    document.addEventListener('pointermove', move, { passive: false });
    document.addEventListener('pointerup', finish);
    document.addEventListener('pointercancel', pointerCancelled);
    document.addEventListener('lostpointercapture', captureLost);
    document.addEventListener('pointerdown', otherPointer);
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('blur', cancel);

    return () => {
      cancel();
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', finish);
      document.removeEventListener('pointercancel', pointerCancelled);
      document.removeEventListener('lostpointercapture', captureLost);
      document.removeEventListener('pointerdown', otherPointer);
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('blur', cancel);
    };
  }, [cancel]);

  function start(event: ReactPointerEvent<HTMLElement>, message: DialogMessage): void {
    if (event.pointerType !== 'touch') {
      return;
    }

    cancel();
    suppressClick.current = false;

    if (
      !event.isPrimary ||
      !latest.current.canRead ||
      latest.current.blocked ||
      window.getSelection()?.toString() ||
      (event.target instanceof Element &&
        event.target.closest('button,a,input,textarea,select,[contenteditable="true"]'))
    ) {
      return;
    }

    const anchor = event.currentTarget;
    const container = anchor.closest<HTMLElement>('.dialog-message-container');

    if (!container) {
      return;
    }

    const style = getComputedStyle(container);
    const read = (name: string): number => Number.parseFloat(style.getPropertyValue(name));
    const current: Gesture = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      anchor,
      container,
      message,
      canSwipe:
        latest.current.canReply &&
        message.actions_verified &&
        event.clientX - (window.visualViewport?.offsetLeft ?? 0) > read('--ui-dialog-swipe-edge'),
      dragging: false,
      offset: 0,
      slop: read('--ui-dialog-swipe-slop'),
      threshold: read('--ui-dialog-swipe-threshold'),
      limit: read('--ui-dialog-swipe-limit'),
      timer: null,
    };

    current.timer = setTimeout(() => {
      if (
        gesture.current === current &&
        anchor.isConnected &&
        latest.current.canRead &&
        !latest.current.blocked &&
        !window.getSelection()?.toString()
      ) {
        cancel();
        latest.current.openMenu(message, anchor);
      }
    }, 500);
    gesture.current = current;
  }

  function click(event: MouseEvent<HTMLElement>): void {
    if (event.detail > 0 && suppressClick.current) {
      event.preventDefault();
      event.stopPropagation();
      suppressClick.current = false;
    }
  }

  return { start, click, cancel };
}
