import { useCallback, useEffect, useRef, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";

/**
 * A press and hold is how a finger selects (Brian's rule): the menu is never the thing a long press opens, it comes from
 * the "⋯" on what is selected. A mouse is unchanged -- a right-click still opens the menu, and a press with a mouse
 * selects at once.
 *
 * The behaviour here is the one Artifacts shipped first and every surface now shares: a hold of HOLD_MS with no more
 * than HOLD_SLOP of travel starts the selection, with a short haptic; the browser's own menu is suppressed while the
 * finger is down and for the click that ends it; and the click a hold ends with is swallowed, so the press does not also
 * open the thing it selected. It is for surfaces whose selection is their own, not the page's text.
 */

/** How long a press has to last to select. */
const HOLD_MS = 450;
/** How far a press may travel before it is a drag and not a hold. */
const HOLD_SLOP = 10;

/** The last event a finger produced was a touch, not a mouse. The emulated mouse events a phone sends after a touch
 *  (pointerdown/up with pointerType "mouse", the click, the contextmenu) are then ignored, so one tap does not select
 *  twice and a long press does not open the menu after the hold has already selected. */
let lastTouch = 0;
/** A touch happened this recently: the mouse events arriving now are the phone's own echo. */
const touchEcho = (within = 700) => Date.now() - lastTouch < within;
/** Note a real touch, so the mouse events that follow it are known for what they are. */
const sawTouch = () => { lastTouch = Date.now(); };

/** A press with a mouse selects at once, as it always has; a hold is only for a finger. */
const pressSelects = (e: { pointerType?: string }) => e.pointerType === "mouse";

interface HoldOptions {
  /** A hold started: select. */
  onHold: (e: ReactPointerEvent<HTMLElement>) => void;
  /** A finger went down or up. */
  onDown?: (e: ReactPointerEvent<HTMLElement>) => void;
  onUp?: (e: ReactPointerEvent<HTMLElement>) => void;
  /** A press was let go without becoming a hold (a tap, or a press that turned into a drag). */
  onTap?: (e: ReactPointerEvent<HTMLElement>) => void;
  /** A long press on the surface also asks for the browser's own menu: suppress it. */
  suppressMenu?: boolean;
  /** Off for a moment (a card being renamed, a drag already running). */
  enabled?: boolean;
}

interface HoldHandlers {
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerLeave: (e: ReactPointerEvent<HTMLElement>) => void;
  onClickCapture: (e: ReactMouseEvent<HTMLElement>) => void;
  onContextMenu: (e: ReactMouseEvent<HTMLElement>) => void;
}

interface Hold {
  /** Spread on the element a press selects. */
  props: HoldHandlers;
  /** A hold is running or has just ended: the click on its way must not also act. */
  isHolding: () => boolean;
  /** For a handler that runs before the click arrives: eat this one. */
  swallow: () => void;
}

/**
 * The hooks a press needs to select by holding. A press that turns into a drag is not a hold: the caller cancels it
 * when it sees the pointer travel (cancel), and the click that ends a hold is swallowed here.
 */
export function useHoldToSelect(opts: HoldOptions): Hold {
  const live = useRef(opts);
  live.current = opts;
  const press = useRef<{ x: number; y: number; timer: number } | null>(null);
  const held = useRef(false);

  const cancel = useCallback(() => {
    if (press.current) window.clearTimeout(press.current.timer);
    press.current = null;
  }, []);
  useEffect(() => cancel, [cancel]);

  const props: HoldHandlers = {
    onPointerDown: (e) => {
      // A new press starts clean: after a hold a phone often sends no click at all, and a flag left set would eat the next tap.
      held.current = false;
      if (e.pointerType === "touch") sawTouch();
      if (live.current.enabled === false || e.button !== 0) return;
      live.current.onDown?.(e);
      if (pressSelects(e)) {
        live.current.onHold(e);
        return;
      }
      cancel();
      press.current = {
        x: e.clientX, y: e.clientY,
        timer: window.setTimeout(() => {
          press.current = null;
          held.current = true;
          navigator.vibrate?.(10);
          live.current.onHold(e);
        }, HOLD_MS),
      };
    },
    onPointerMove: (e) => {
      const p = press.current;
      if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > HOLD_SLOP) cancel();
    },
    onPointerUp: (e) => {
      const wasHolding = !!press.current;
      cancel();
      live.current.onUp?.(e);
      if (wasHolding) live.current.onTap?.(e);
    },
    onPointerCancel: (e) => { cancel(); live.current.onUp?.(e); },
    onPointerLeave: () => cancel(),
    // The click that ends a hold must not also act on what was pressed.
    onClickCapture: (e) => {
      if (!held.current) return;
      held.current = false;
      e.preventDefault();
      e.stopPropagation();
    },
    // A long press on a phone also asks for the browser's own menu: it is not the menu here.
    onContextMenu: (e) => {
      if (live.current.suppressMenu && (press.current || held.current || touchEcho())) e.preventDefault();
    },
  };

  return {
    props,
    isHolding: () => !!press.current || held.current,
    swallow: () => { held.current = true; },
  };
}
