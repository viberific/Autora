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

/** Where the room for work ends on a phone: just above the conversation's sheet, which lies over the foot of the board.
    A sheet opened to the full screen covers the board; the work keeps the room a half sheet leaves, so nothing is
    re-framed into no room at all while the person reads. */
function aboveSheet(board: DOMRect): number {
  const sheet = document.querySelector(".conversation-flow.is-sheet")?.getBoundingClientRect();
  if (!sheet || sheet.height === 0 || sheet.top >= board.bottom || sheet.bottom <= board.top) return board.bottom;
  const top = sheet.top - 8 > board.top + board.height * 0.2 ? sheet.top - 8 : board.top + board.height * 0.45;
  return Math.min(board.bottom, top);
}

/** The conversation's floating window on a desktop, where it is on screen; none on a phone, where it is a sheet. */
function floatingConversation(): DOMRect | undefined {
  const box = document.querySelector(".conversation-flow.is-float")?.getBoundingClientRect();
  return box && box.width > 0 && box.height > 0 ? box : undefined;
}

export function workViewport(board: Element, opts: { clearDock?: boolean } = {}): { left: number; top: number; width: number; height: number } {
  const rect = board.getBoundingClientRect();
  const float = floatingConversation();
  const navigation = document.querySelector(".conversation-flow__work-navigation")?.getBoundingClientRect();
  const overlaps = (other: DOMRect) => other.left < rect.right && other.right > rect.left && other.top < rect.bottom && other.bottom > rect.top;
  // A phone's sheet lies over the foot of the canvas: the room for work ends above it.
  let bottom = float ? rect.bottom : aboveSheet(rect);
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
  if (navigation && navigation.width > 0 && overlaps(navigation)) {
    if (navigation.left - left < right - navigation.right) left = Math.max(left, navigation.right + 8);
    else right = Math.min(right, navigation.left - 8);
  }
  /* The desktop's floating conversation is kept clear too, by whichever costs the work less room: the band beside it
     (on the side with more of the board), or, when it is a short window standing at the foot of the board, the strip
     above it. A chat of one line does not take a whole column from the work, and a tall one does not take the floor. */
  if (float && overlaps(float)) {
    const onLeft = float.left - left < right - float.right;
    const beside = Math.max(0, onLeft ? right - (float.right + 8) : float.left - 8 - left) * Math.max(0, bottom - rect.top);
    const aboveH = float.top - 8 - rect.top;
    const atFoot = aboveH > bottom - (float.bottom + 8);
    const above = atFoot ? Math.max(0, right - left) * Math.max(0, aboveH) : 0;
    if (above > beside) bottom = Math.min(bottom, float.top - 8);
    else if (onLeft) left = Math.max(left, float.right + 8);
    else right = Math.min(right, float.left - 8);
  }
  return { left, top: rect.top, width: Math.max(0, right - left), height: Math.max(0, bottom - rect.top) };
}
