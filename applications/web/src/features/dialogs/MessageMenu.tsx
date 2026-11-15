import { reactionCatalog, reactionGlyph } from '@gchat/dialog-assets';
import {
  ArrowLeft,
  ChevronDown,
  Copy,
  Forward,
  Link as LinkIcon,
  Pencil,
  Reply,
  TextSelect,
} from 'lucide-react';
import type { JSX } from 'react';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import type { DialogMessage } from '../../shared/dialogs/model';
import { messageLinks } from './message-links';
import { MessageMenuPreview } from './MessageMenuPreview';

export function MessageMenu({
  anchor,
  close,
  edit,
  message,
  canReact = false,
  forward,
  reply,
  react,
  own = false,
  copied,
  read,
}: {
  anchor: HTMLElement;
  close(restoreFocus: boolean): void;
  edit?(): void;
  message?: DialogMessage;
  canReact?: boolean;
  forward?(): void;
  reply?(): void;
  react?(emoji: string): Promise<void>;
  own?: boolean;
  copied?(): void;
  read?: boolean;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [choosingLink, setChoosingLink] = useState(false);
  const [selectingText, setSelectingText] = useState(false);
  const [status, setStatus] = useState('');
  const [manual, setManual] = useState<string | null>(null);
  const [pending, setPending] = useState<string[]>([]);
  const active = useRef(false);
  const lifetime = useRef(0);
  const source = useRef<HTMLElement | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const selectable = useRef<HTMLDivElement>(null);
  const shade = useRef<HTMLDivElement>(null);
  const pointerActivation = useRef(false);
  const dismiss = useCallback(
    (restoreFocus: boolean): void => {
      source.current?.classList.remove('dialog-message-menu-source');
      close(restoreFocus);
    },
    [close],
  );
  const links = message?.content.kind === 'text' ? messageLinks(message.content.text) : [];

  function copy(value: string): void {
    setManual(null);
    setStatus('');

    if (!navigator.clipboard?.writeText) {
      setManual(value);

      return;
    }

    const currentLifetime = lifetime.current;

    void (async () => {
      try {
        await navigator.clipboard.writeText(value);

        if (active.current && lifetime.current === currentLifetime) {
          copied?.();
          dismiss(true);
        }
      } catch {
        if (active.current && lifetime.current === currentLifetime) {
          setManual(value);
        }
      }
    })();
  }
  function chooseReaction(emoji: string): void {
    if (!react || pending.includes(emoji)) {
      return;
    }

    const currentLifetime = lifetime.current;

    setStatus('');
    setPending((values) => [...values, emoji]);
    void (async () => {
      try {
        await react(emoji);

        if (active.current && lifetime.current === currentLifetime) {
          dismiss(true);
        }
      } catch {
        if (active.current && lifetime.current === currentLifetime) {
          setStatus('Не удалось изменить реакцию');
        }
      } finally {
        if (active.current && lifetime.current === currentLifetime) {
          setPending((values) => values.filter((value) => value !== emoji));
        }
      }
    })();
  }
  const menu = useRef<HTMLDivElement>(null);
  const returnToReactions = useRef(false);
  const returnToSelection = useRef(false);
  const reposition = useRef<(() => void) | null>(null);

  function showReactions(): void {
    if (body.current && menu.current) {
      menu.current.style.setProperty('--dialog-menu-body-height', body.current.offsetHeight + 'px');
    }

    setStatus('');
    setExpanded(true);
  }

  function back(): void {
    returnToReactions.current = expanded;
    returnToSelection.current = selectingText;
    setExpanded(false);
    setSelectingText(false);
    setChoosingLink(false);
    setManual(null);
    setStatus('');
  }

  useLayoutEffect((): (() => void) => {
    const node = menu.current;

    if (!node || !anchor.isConnected) {
      return (): void => {};
    }

    const nativePopover = typeof node.showPopover === 'function';

    active.current = true;
    pointerActivation.current = false;
    lifetime.current += 1;
    source.current = anchor.matches('.dialog-message')
      ? anchor
      : (anchor.closest('.dialog-message-container')?.querySelector('.dialog-message') ?? null);

    if (nativePopover) {
      node.showPopover();
    }

    const viewport = window.visualViewport;
    const feed = anchor.closest<HTMLElement>('.dialog-feed-wrapper');
    let anchorRect = (source.current ?? anchor).getBoundingClientRect();

    const position = (): void => {
      const gap = Number.parseFloat(
        getComputedStyle(node).getPropertyValue('--dialog-menu-edge-space'),
      );
      const target = source.current ?? anchor;

      if (target.isConnected) {
        anchorRect = target.getBoundingClientRect();
      }

      const rect = anchorRect;
      const viewportLeft = viewport?.offsetLeft ?? 0;
      const viewportTop = viewport?.offsetTop ?? 0;
      const viewportRight = viewportLeft + (viewport?.width ?? innerWidth);
      const viewportBottom = viewportTop + (viewport?.height ?? innerHeight);
      const feedRect = feed?.isConnected ? feed.getBoundingClientRect() : null;
      const left = Math.max(viewportLeft, feedRect?.left ?? viewportLeft);
      const top = Math.max(viewportTop, feedRect?.top ?? viewportTop);
      const width = Math.max(0, Math.min(viewportRight, feedRect?.right ?? viewportRight) - left);
      const height = Math.max(
        0,
        Math.min(viewportBottom, feedRect?.bottom ?? viewportBottom) - top,
      );

      if (shade.current) {
        shade.current.style.left = left + 'px';
        shade.current.style.top = top + 'px';
        shade.current.style.width = width + 'px';
        shade.current.style.height = height + 'px';
      }

      node.style.maxWidth = Math.max(0, width - gap * 2) + 'px';
      node.style.maxHeight = Math.max(0, height - gap * 2) + 'px';
      node.style.left =
        Math.max(
          left + gap,
          Math.min(
            message && !own ? rect.left : rect.right - node.offsetWidth,
            left + width - node.offsetWidth - gap,
          ),
        ) + 'px';
      const preview = node.querySelector<HTMLElement>('.dialog-message-menu-preview');
      const preferred = preview ? rect.top - preview.offsetTop : rect.top - node.offsetHeight - gap;

      node.style.top =
        Math.max(top + gap, Math.min(preferred, top + height - node.offsetHeight - gap)) + 'px';
    };

    position();
    reposition.current = position;
    node.querySelector<HTMLElement>('[role="menuitem"]')?.focus({ preventScroll: true });

    if (message) {
      source.current?.classList.add('dialog-message-menu-source');
    }

    let positionFrame: number | null = null;
    const observer = new ResizeObserver(() => {
      if (positionFrame === null) {
        positionFrame = requestAnimationFrame(() => {
          positionFrame = null;
          position();
        });
      }
    });

    observer.observe(node);

    if (feed) {
      observer.observe(feed);
    }

    let outsidePress: { pointerId: number; x: number; y: number } | null = null;
    const isOutside = (target: EventTarget | null): boolean =>
      target instanceof Node && !node.contains(target) && !anchor.contains(target);
    const startOutsidePress = (event: PointerEvent): void => {
      outsidePress =
        event.isPrimary && event.button === 0 && isOutside(event.target)
          ? { pointerId: event.pointerId, x: event.clientX, y: event.clientY }
          : null;
    };
    const moveOutsidePress = (event: PointerEvent): void => {
      if (
        outsidePress?.pointerId === event.pointerId &&
        Math.hypot(event.clientX - outsidePress.x, event.clientY - outsidePress.y) > 8
      ) {
        outsidePress = null;
      }
    };
    const cancelOutsidePress = (): void => {
      outsidePress = null;
    };
    const finishOutsidePress = (event: PointerEvent): void => {
      moveOutsidePress(event);
      const shouldDismiss = outsidePress?.pointerId === event.pointerId && isOutside(event.target);

      outsidePress = null;

      if (shouldDismiss) {
        dismiss(false);
      }
    };
    const toggle = (event: Event): void => {
      if ('newState' in event && event.newState === 'closed') {
        dismiss(true);
      }
    };

    document.addEventListener('pointerdown', startOutsidePress, true);
    document.addEventListener('pointermove', moveOutsidePress, true);
    document.addEventListener('pointerup', finishOutsidePress, true);
    document.addEventListener('pointercancel', cancelOutsidePress, true);
    document.addEventListener('scroll', position, true);
    window.addEventListener('resize', position);
    viewport?.addEventListener('resize', position);
    viewport?.addEventListener('scroll', position);
    node.addEventListener('toggle', toggle);

    return (): void => {
      observer.disconnect();
      active.current = false;
      source.current?.classList.remove('dialog-message-menu-source');
      reposition.current = null;

      if (positionFrame !== null) {
        cancelAnimationFrame(positionFrame);
      }

      document.removeEventListener('pointerdown', startOutsidePress, true);
      document.removeEventListener('pointermove', moveOutsidePress, true);
      document.removeEventListener('pointerup', finishOutsidePress, true);
      document.removeEventListener('pointercancel', cancelOutsidePress, true);
      document.removeEventListener('scroll', position, true);
      window.removeEventListener('resize', position);
      viewport?.removeEventListener('resize', position);
      viewport?.removeEventListener('scroll', position);
      node.removeEventListener('toggle', toggle);

      if (nativePopover && node.matches(':popover-open')) {
        node.hidePopover();
      }
    };
  }, [anchor, dismiss, message?.message_id, own]);

  useLayoutEffect(() => {
    const frame = requestAnimationFrame(() => reposition.current?.());

    return () => cancelAnimationFrame(frame);
  }, [message?.reaction_version, message?.version]);

  useLayoutEffect(() => {
    let target: HTMLElement | null | undefined;

    if (manual !== null) {
      target = menu.current?.querySelector('textarea');
    } else if (selectingText) {
      target = selectable.current;
    } else if (choosingLink) {
      target = menu.current?.querySelector('button');
    } else if (expanded) {
      target = menu.current?.querySelector('.dialog-reaction-picker button');
    } else {
      if (returnToReactions.current) {
        target = menu.current?.querySelector('[data-expand]');
      } else if (returnToSelection.current) {
        target = menu.current?.querySelector('[data-select-text]');
      } else {
        target = menu.current?.querySelector('.dialog-message-menu-actions button');
      }

      returnToReactions.current = false;
      returnToSelection.current = false;
    }

    target?.focus({ preventScroll: true });
  }, [expanded, choosingLink, manual, selectingText]);

  useLayoutEffect(() => {
    const node = selectable.current;

    return () => {
      const selection = window.getSelection();

      if (node && selection?.anchorNode && node.contains(selection.anchorNode)) {
        selection.removeAllRanges();
      }
    };
  }, [selectingText]);

  return createPortal(
    <div
      ref={menu}
      // A long press opens while the pointer is still down outside this node.
      // Native auto light-dismiss would treat its release as an outside gesture.
      popover="manual"
      role={selectingText ? 'dialog' : 'menu'}
      aria-label={selectingText ? 'Выделить текст' : 'Действия сообщения'}
      className="dialog-message-menu"
      data-expanded={expanded || undefined}
      data-focused={!!message || undefined}
      onPointerDownCapture={(event): void => {
        pointerActivation.current = event.isPrimary && event.button === 0;
      }}
      onPointerCancelCapture={(): void => {
        pointerActivation.current = false;
      }}
      onClickCapture={(event): void => {
        // Clamping can move a command under the finger that opened the menu.
        // Its release must not activate a command without a new press here.
        if (event.detail > 0 && !pointerActivation.current) {
          event.preventDefault();
          event.stopPropagation();
        }

        pointerActivation.current = false;
      }}
      onKeyDown={(event): void => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();

          if (expanded || choosingLink || manual !== null || selectingText) {
            back();
          } else {
            dismiss(true);
          }

          return;
        }

        if (
          event.target instanceof HTMLTextAreaElement ||
          (event.target instanceof Node && selectable.current?.contains(event.target))
        ) {
          return;
        }

        if (
          ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)
        ) {
          event.preventDefault();
          const grid =
            expanded && event.target instanceof HTMLElement
              ? event.target.closest('.dialog-reaction-picker')
              : null;
          const buttons = [
            ...((grid ?? menu.current)?.querySelectorAll<HTMLButtonElement>(
              'button:not(:disabled)',
            ) ?? []),
          ].filter((button) => button.offsetHeight > 0);
          const index =
            document.activeElement instanceof HTMLButtonElement
              ? buttons.indexOf(document.activeElement)
              : -1;
          let next = index;

          if (event.key === 'Home') {
            next = grid ? Math.floor(index / 6) * 6 : 0;
          } else if (event.key === 'End') {
            next = grid
              ? Math.min(buttons.length - 1, Math.floor(index / 6) * 6 + 5)
              : buttons.length - 1;
          } else {
            let step = 1;

            if (event.key === 'ArrowUp') {
              step = grid ? -6 : -1;
            } else if (event.key === 'ArrowDown') {
              step = grid ? 6 : 1;
            } else if (event.key === 'ArrowLeft') {
              step = -1;
            }

            next += step;
          }

          buttons[(next + buttons.length) % buttons.length]?.focus();
        }
      }}
    >
      {message && <div ref={shade} className="dialog-message-menu-shade" aria-hidden="true" />}
      {selectingText || expanded ? (
        <div className="dialog-message-menu-heading">
          <button
            type="button"
            role={selectingText ? undefined : 'menuitem'}
            aria-label="Назад к действиям"
            onClick={back}
          >
            <ArrowLeft aria-hidden="true" />
          </button>
          <span>{selectingText ? 'Выделить текст' : 'Реакции'}</span>
          <button
            type="button"
            role={selectingText ? undefined : 'menuitem'}
            onClick={() => dismiss(true)}
          >
            Готово
          </button>
        </div>
      ) : (
        manual === null &&
        !choosingLink &&
        message &&
        canReact && (
          <div className="dialog-reactions-panel">
            <div className="dialog-reaction-picker" role="group" aria-label="Быстрые реакции">
              {reactionCatalog
                .filter((item) => ['👍', '❤', '🔥', '🥰', '👏', '😁'].includes(item.emoji))
                .map((item) => (
                  <button
                    type="button"
                    key={item.emoji}
                    aria-label={'Реакция: ' + item.label}
                    aria-pressed={message.own_reaction_states.some(
                      (cell) => cell.emoji === item.emoji && cell.selected,
                    )}
                    disabled={pending.includes(item.emoji)}
                    onClick={() => chooseReaction(item.emoji)}
                  >
                    {reactionGlyph(item.emoji)}
                  </button>
                ))}
              <button
                type="button"
                role="menuitem"
                data-expand
                className="dialog-reaction-expand"
                aria-label="Все реакции"
                aria-expanded={expanded}
                onClick={showReactions}
              >
                <ChevronDown aria-hidden="true" />
              </button>
            </div>
          </div>
        )
      )}
      {message && !selectingText && <MessageMenuPreview message={message} own={own} read={read} />}
      <div ref={body} className="dialog-message-menu-body">
        {selectingText && message?.content.kind === 'text' && (
          <div
            ref={selectable}
            className="dialog-selectable-text"
            role="document"
            aria-label="Текст для выделения"
            tabIndex={0}
          >
            {message.content.text}
          </div>
        )}
        {manual !== null && (
          <div className="dialog-copy-fallback dialog-message-menu-actions">
            <button type="button" role="menuitem" onClick={back}>
              <span>Назад</span>
              <ArrowLeft aria-hidden="true" />
            </button>
            <p role="alert">
              Не удалось скопировать автоматически. Выделите текст и скопируйте вручную.
            </p>
            <textarea
              readOnly
              aria-label="Текст для копирования"
              value={manual}
              onFocus={(event) => event.currentTarget.select()}
            />
          </div>
        )}
        {manual === null && choosingLink && (
          <div className="dialog-message-menu-actions">
            <button type="button" role="menuitem" onClick={back}>
              <span>Назад</span>
              <ArrowLeft aria-hidden="true" />
            </button>
            {links.map((url) => (
              <button type="button" role="menuitem" key={url} onClick={() => copy(url)}>
                <span className="dialog-link-address">{url}</span>
              </button>
            ))}
          </div>
        )}
        {manual === null && !choosingLink && expanded && message && canReact && (
          <div className="dialog-reaction-picker expanded" role="group" aria-label="Все реакции">
            {reactionCatalog.map((item) => (
              <button
                type="button"
                key={item.emoji}
                aria-label={'Реакция: ' + item.label}
                aria-pressed={message.own_reaction_states.some(
                  (cell) => cell.emoji === item.emoji && cell.selected,
                )}
                disabled={pending.includes(item.emoji)}
                onClick={() => chooseReaction(item.emoji)}
              >
                {reactionGlyph(item.emoji)}
              </button>
            ))}
          </div>
        )}
        {manual === null &&
          !selectingText &&
          !choosingLink &&
          !(expanded && message && canReact) && (
            <div className="dialog-message-menu-actions">
              {reply && (
                <button type="button" role="menuitem" onClick={reply}>
                  <span>Ответить</span>
                  <Reply size={20} aria-hidden="true" />
                </button>
              )}
              {message?.content.kind === 'text' && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    if (message.content.kind === 'text') {
                      copy(message.content.text);
                    }
                  }}
                >
                  <span>Копировать текст</span>
                  <Copy size={20} aria-hidden="true" />
                </button>
              )}
              {message?.content.kind === 'text' && (
                <button
                  type="button"
                  role="menuitem"
                  data-select-text
                  onClick={() => {
                    setStatus('');
                    setSelectingText(true);
                  }}
                >
                  <span>Выделить текст</span>
                  <TextSelect size={20} aria-hidden="true" />
                </button>
              )}
              {forward && (
                <button type="button" role="menuitem" onClick={forward}>
                  <span>Переслать</span>
                  <Forward size={20} aria-hidden="true" />
                </button>
              )}
              {(edit || links.length > 0) &&
                (reply || forward || message?.content.kind === 'text') && (
                  <hr className="dialog-message-menu-divider" />
                )}
              {edit && (
                <button type="button" role="menuitem" onClick={edit}>
                  <span>Редактировать</span>
                  <Pencil size={20} aria-hidden="true" />
                </button>
              )}
              {links.length > 0 && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => (links.length === 1 ? copy(links[0]!) : setChoosingLink(true))}
                >
                  <span>Копировать ссылку</span>
                  <LinkIcon size={20} aria-hidden="true" />
                </button>
              )}
            </div>
          )}
      </div>
      {status && <p role="alert">{status}</p>}
    </div>,
    document.body,
  );
}
