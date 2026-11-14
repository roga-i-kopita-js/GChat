import { Pencil } from 'lucide-react';
import type { JSX } from 'react';
import { useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

export function MessageMenu({
  anchor,
  close,
  edit,
}: {
  anchor: HTMLElement;
  close(restoreFocus: boolean): void;
  edit(): void;
}): JSX.Element {
  const menu = useRef<HTMLDivElement>(null);
  const action = useRef<HTMLButtonElement>(null);

  useLayoutEffect((): (() => void) => {
    const node = menu.current;

    if (!node || !anchor.isConnected) {
      return (): void => {};
    }

    const nativePopover = typeof node.showPopover === 'function';

    if (nativePopover) {
      node.showPopover();
    }

    const rect = anchor.getBoundingClientRect();
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft ?? 0;
    const top = viewport?.offsetTop ?? 0;
    const width = viewport?.width ?? innerWidth;
    const height = viewport?.height ?? innerHeight;
    const gap = Number.parseFloat(getComputedStyle(node).getPropertyValue('--ui-space-2'));

    node.style.maxWidth = Math.max(0, width - gap * 2) + 'px';
    node.style.left =
      Math.max(
        left + gap,
        Math.min(rect.right - node.offsetWidth, left + width - node.offsetWidth - gap),
      ) + 'px';
    const below = rect.bottom + gap;
    const above = rect.top - node.offsetHeight - gap;

    node.style.top =
      Math.max(
        top + gap,
        Math.min(
          below + node.offsetHeight <= top + height - gap ? below : above,
          top + height - node.offsetHeight - gap,
        ),
      ) + 'px';
    action.current?.focus({ preventScroll: true });

    const outside = (event: PointerEvent): void => {
      if (event.target instanceof Node && !node.contains(event.target)) {
        close(false);
      }
    };
    const scroll = (event: Event): void => {
      if (event.target instanceof Node && node.contains(event.target)) {
        return;
      }

      close(true);
    };
    const resize = (): void => close(true);
    const toggle = (event: Event): void => {
      if ('newState' in event && event.newState === 'closed') {
        close(true);
      }
    };

    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', resize);
    viewport?.addEventListener('resize', resize);
    node.addEventListener('toggle', toggle);

    return (): void => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('scroll', scroll, true);
      window.removeEventListener('resize', resize);
      viewport?.removeEventListener('resize', resize);
      node.removeEventListener('toggle', toggle);

      if (nativePopover && node.matches(':popover-open')) {
        node.hidePopover();
      }
    };
  }, [anchor, close]);

  return createPortal(
    <div
      ref={menu}
      popover="auto"
      role="menu"
      aria-label="Действия сообщения"
      className="dialog-message-menu"
      onKeyDown={(event): void => {
        if (event.key === 'Escape') {
          event.preventDefault();
          close(true);
        }

        if (event.key === 'Tab') {
          close(true);
        }

        if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          action.current?.focus();
        }
      }}
    >
      <button ref={action} type="button" role="menuitem" onClick={edit}>
        <span>Редактировать</span>
        <Pencil size={20} aria-hidden="true" />
      </button>
    </div>,
    document.body,
  );
}
