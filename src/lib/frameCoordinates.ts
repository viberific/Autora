/** Map engine-local coordinates into the zoomed shared scene's screen coordinates. */
export function scaledFramePoint(
  rect: { left: number; top: number; width: number; height: number },
  size: { width: number; height: number },
  point: { x: number; y: number },
): { x: number; y: number } {
  if (![rect.left, rect.top, rect.width, rect.height, size.width, size.height, point.x, point.y].every(Number.isFinite) ||
      size.width <= 0 || size.height <= 0 || rect.width <= 0 || rect.height <= 0) throw new RangeError("The engine frame has no visible geometry.");
  return { x: rect.left + point.x * rect.width / size.width, y: rect.top + point.y * rect.height / size.height };
}

export function framePoint(frame: HTMLIFrameElement, point: { x: number; y: number }): { x: number; y: number } | null {
  const rect = frame.getBoundingClientRect();
  if (!frame.clientWidth || !frame.clientHeight || !rect.width || !rect.height) return null;
  return scaledFramePoint(rect, { width: frame.clientWidth, height: frame.clientHeight }, point);
}

export function elementScale(element: HTMLElement): number {
  return element.offsetWidth > 0 ? element.getBoundingClientRect().width / element.offsetWidth : 1;
}

export function workRectVisible(
  rect: { left: number; top: number; width: number; height: number },
  viewport: { left: number; top: number; width: number; height: number },
): boolean {
  return rect.width > 0 && rect.height > 0 && viewport.width > 0 && viewport.height > 0 &&
    rect.left >= viewport.left - 1 && rect.top >= viewport.top - 1 &&
    rect.left + rect.width <= viewport.left + viewport.width + 1 &&
    rect.top + rect.height <= viewport.top + viewport.height + 1;
}

export function isWorkVisible(element: Element, opts: { whole?: boolean } = {}): boolean {
  if (document.visibilityState !== "visible") return false;
  const rect = element.getBoundingClientRect();
  const board = element.closest(".pa-board");
  /* A whole window (an editor's frame, or an in-page window such as Music's) is judged as a window, not as a control. */
  const whole = opts.whole ?? element instanceof HTMLIFrameElement;
  if (!whole && !workRectVisible(rect, { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight })) return false;
  if (!board) return true;
  /* Inside the board above the entry, and not under the work navigation. That navigation is a small box in a corner,
     so it hides only what it actually covers: workViewport's band (the whole height beside it) is for placing the
     camera, and taken as what can be seen it hid a phone's picker and most panels from the agent's hand. */
  const b = board.getBoundingClientRect();
  /* A phone's sheet runs along the foot of the board: what is above its entry is in view. A desktop's floating window
     is a box over the board like the navigation, so it hides only what it covers. */
  const float = floatingConversation();
  const entry = float ? undefined : document.querySelector(".conversation-flow__entry-area")?.getBoundingClientRect();
  const bottom = entry && entry.height > 0 && entry.top < b.bottom && entry.bottom > b.top ? Math.min(b.bottom, entry.top - 8) : b.bottom;
  const room = { left: b.left, top: b.top, width: b.width, height: Math.max(0, bottom - b.top) };
  const nav = document.querySelector(".conversation-flow__work-navigation")?.getBoundingClientRect();
  const under = (box: DOMRect | undefined, r: DOMRect) => !!box && box.width > 0 && r.right > box.left && r.left < box.right && r.bottom > box.top && r.top < box.bottom;
  /* An editor's whole frame is "on screen" when most of it is, its middle clear of the jump buttons: a window a person
     can see and work in, though an edge runs under the buttons or off the board. */
  if (whole) {
    const w = Math.max(0, Math.min(rect.right, room.left + room.width) - Math.max(rect.left, room.left));
    const h = Math.max(0, Math.min(rect.bottom, room.top + room.height) - Math.max(rect.top, room.top));
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const clearOf = (box: DOMRect | undefined) => !box || box.width === 0 || cx < box.left || cx > box.right || cy < box.top || cy > box.bottom;
    const middleClear = clearOf(nav) && clearOf(float);
    return rect.width > 0 && rect.height > 0 && (w * h) / (rect.width * rect.height) >= 0.5 && middleClear;
  }
  if (!workRectVisible(rect, room)) return false;
  return !under(nav, rect) && !under(float, rect);
}

/** The conversation's floating window on a desktop, where it is on screen; none on a phone, where it is a sheet. */
function floatingConversation(): DOMRect | undefined {
  const box = document.querySelector(".conversation-flow.is-float")?.getBoundingClientRect();
  return box && box.width > 0 && box.height > 0 ? box : undefined;
}

export function workViewport(board: Element, opts: { clearDock?: boolean } = {}): { left: number; top: number; width: number; height: number } {
  const rect = board.getBoundingClientRect();
  const float = floatingConversation();
  const entry = float ? undefined : document.querySelector(".conversation-flow__entry-area")?.getBoundingClientRect();
  const navigation = document.querySelector(".conversation-flow__work-navigation")?.getBoundingClientRect();
  // A phone's sheet is under the canvas, so its entry only costs room where it really overlaps.
  const overlaps = (other: DOMRect) => other.left < rect.right && other.right > rect.left && other.top < rect.bottom && other.bottom > rect.top;
  let bottom = entry && entry.height > 0 && overlaps(entry) ? Math.min(rect.bottom, entry.top - 8) : rect.bottom;
  // The board's own bottom row (the history slider): on a phone a window is kept clear of it, not drawn under it.
  if (opts.clearDock) {
    for (const el of Array.from(board.querySelectorAll(".pa-dock > *"))) {
      const r = el.getBoundingClientRect();
      if (r.height > 0 && r.width > 0 && overlaps(r)) bottom = Math.min(bottom, r.top - 8);
    }
  }
  /* The work rail stands on the canvas beside the conversation: along its left edge on a desktop (the conversation is
     on the left), its right edge on a phone. Whichever side it is on, that side's band is kept clear of it. */
  let left = rect.left;
  let right = rect.right;
  /* The desktop's floating conversation is kept clear the same way: the band beside it on whichever side it stands. */
  for (const band of [navigation, float]) {
    if (!band || band.width === 0 || !overlaps(band)) continue;
    if (band.left + band.width / 2 < rect.left + rect.width / 2) left = Math.max(left, band.right + 8);
    else right = Math.min(right, band.left - 8);
  }
  return { left, top: rect.top, width: Math.max(0, right - left), height: Math.max(0, bottom - rect.top) };
}
