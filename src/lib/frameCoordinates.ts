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

export function isWorkVisible(element: Element): boolean {
  if (document.visibilityState !== "visible") return false;
  const rect = element.getBoundingClientRect();
  const board = element.closest(".pa-board");
  return workRectVisible(rect, { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight }) &&
    (!board || workRectVisible(rect, workViewport(board)));
}

export function workViewport(board: Element): { left: number; top: number; width: number; height: number } {
  const rect = board.getBoundingClientRect();
  const entry = document.querySelector(".conversation-flow__entry-area")?.getBoundingClientRect();
  const navigation = document.querySelector(".conversation-flow__work-navigation")?.getBoundingClientRect();
  const bottom = entry && entry.height > 0 ? Math.min(rect.bottom, entry.top - 8) : rect.bottom;
  const right = navigation && navigation.width > 0 ? Math.min(rect.right, navigation.left - 8) : rect.right;
  return { left: rect.left, top: rect.top, width: Math.max(0, right - rect.left), height: Math.max(0, bottom - rect.top) };
}
