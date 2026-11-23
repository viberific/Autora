/**
 * A finger's long press selects; the menu comes from the "⋯" on what is picked.
 *
 * The timeline's clips and track rows carry the editor's own right-click menu (Radix). On a phone a long press fires
 * the browser's contextmenu, which opened that menu instead of selecting (Brian's rule: a hold never opens the menu).
 * So the press is timed here, the menu is swallowed while it is down and for the events a touch leaves behind, and the
 * "⋯" opens the menu itself. A mouse is unchanged: its right-click still opens the menu.
 */

export const HOLD_MS = 450;
export const HOLD_SLOP = 10;

/** A touch happened this recently: the mouse events arriving now are the phone's own echo. */
let lastTouch = 0;
const echo = () => Date.now() - lastTouch < 700;

export interface HoldOptions {
  /** The finger has held: select what is under it and offer the "⋯" at this point. */
  onHold: (at: { x: number; y: number }) => void;
  /** A press ended without becoming a hold. */
  onTap?: () => void;
  /** It is picked: the "⋯" on it is drawn. */
  picked?: boolean;
}

/** The press a timeline element starts on a finger. Returns a function that ends it. */
export function beginHold(e: React.PointerEvent, opts: HoldOptions): () => void {
  if (e.pointerType === "touch") lastTouch = Date.now();
  const at = { x: e.clientX, y: e.clientY };
  let timer: number | null = window.setTimeout(() => {
    timer = null;
    navigator.vibrate?.(10);
    opts.onHold(at);
  }, HOLD_MS);
  const stop = () => {
    if (timer !== null) { window.clearTimeout(timer); timer = null; }
    document.removeEventListener("pointermove", move, true);
    document.removeEventListener("pointerup", lift, true);
    document.removeEventListener("pointercancel", lift, true);
  };
  const move = (ev: PointerEvent) => {
    if (timer !== null && Math.hypot(ev.clientX - at.x, ev.clientY - at.y) > HOLD_SLOP) { window.clearTimeout(timer); timer = null; }
  };
  const lift = () => { const wasHolding = timer === null; stop(); if (!wasHolding) opts.onTap?.(); };
  document.addEventListener("pointermove", move, true);
  document.addEventListener("pointerup", lift, true);
  document.addEventListener("pointercancel", lift, true);
  return stop;
}

/** Whether this contextmenu is a finger's, not a mouse's: it is the phone's own and is not the menu here. */
export function touchMenu(e: { pointerType?: string }, holding: boolean): boolean {
  if (e.pointerType === "touch") return true;
  return holding || echo();
}
