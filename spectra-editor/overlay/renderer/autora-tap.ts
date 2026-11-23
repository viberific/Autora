// Autora (phone): what a tap on text means to the Redact tool.
//
// A redaction on a phone is "tap what you want gone", not "drag a box over it". The page's text layer (pdf.js's own
// spans, laid over the raster) says where the words are, so the tap is answered from that: the word nearest the finger,
// or the run (line) it belongs to. The box that results goes through Spectra's own redaction mark, so what is removed
// from the file is exactly what is drawn.

/** The client-space box of the word or line under (cx, cy) inside one page, or null when there is no text there. */
export function textRectAt(page: HTMLElement, cx: number, cy: number, mode: 'word' | 'line'): DOMRect | null {
  const SLACK = 8;
  const spans = page.querySelectorAll<HTMLElement>('.textLayer span:not(.markedContent)');
  let hit: HTMLElement | null = null;
  let hitBox: DOMRect | null = null;
  for (const span of spans) {
    if (!span.textContent?.trim()) continue;
    const b = span.getBoundingClientRect();
    if (cx < b.left - SLACK || cx > b.right + SLACK || cy < b.top - SLACK || cy > b.bottom + SLACK) continue;
    // Several can be near a tap on a tight line: the one the finger is inside wins.
    const inside = cx >= b.left && cx <= b.right && cy >= b.top && cy <= b.bottom;
    if (!hit || inside) { hit = span; hitBox = b; }
    if (inside) break;
  }
  if (!hit || !hitBox) return null;
  if (mode === 'line') return hitBox;
  const node = hit.firstChild;
  if (!node || node.nodeType !== Node.TEXT_NODE) return hitBox;
  const text = node.textContent ?? '';
  let best: DOMRect | null = null;
  let bestDistance = Infinity;
  for (const m of text.matchAll(/\S+/g)) {
    const start = m.index ?? 0;
    // A word does not take the comma or full stop that ends the sentence.
    const word = m[0].replace(/[,;:.!?)]+$/, '') || m[0];
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, start + word.length);
    const r = range.getBoundingClientRect();
    const dx = cx < r.left ? r.left - cx : cx > r.right ? cx - r.right : 0;
    const dy = cy < r.top ? r.top - cy : cy > r.bottom ? cy - r.bottom : 0;
    const d = Math.hypot(dx, dy);
    if (d < bestDistance) { bestDistance = d; best = r; }
  }
  return best ?? hitBox;
}

// ---------------------------------------------------------------------------
// A finger's long press selects, and the menu comes from a "⋯" on the page
// (Brian's rule: a hold never opens the menu itself; a mouse's right-click
// still does). The page cell calls these; the canvas draws the "⋯".
// ---------------------------------------------------------------------------

const HOLD_MS = 450;
const HOLD_SLOP = 10;
/** A touch happened this recently: the mouse events arriving now are the phone's own echo. */
let lastTouch = 0;
const echo = () => Date.now() - lastTouch < 700;

export interface HoldHooks {
  /** The finger has held long enough: select what is under it and offer the "⋯" at this point. */
  onHold: (at: { x: number; y: number }) => void;
  /** A press ended without becoming a hold: the "⋯" of the last one goes. */
  onTap: () => void;
}

/** The press a page cell starts on a finger. Returns a function that ends it. */
export function beginHold(e: React.PointerEvent, hooks: HoldHooks): () => void {
  if (e.pointerType === 'touch') lastTouch = Date.now();
  const at = { x: e.clientX, y: e.clientY };
  let timer: number | null = window.setTimeout(() => {
    timer = null;
    navigator.vibrate?.(10);
    hooks.onHold(at);
  }, HOLD_MS);
  const stop = () => {
    if (timer !== null) { window.clearTimeout(timer); timer = null; }
    document.removeEventListener('pointermove', move, true);
    document.removeEventListener('pointerup', lift, true);
    document.removeEventListener('pointercancel', lift, true);
  };
  const move = (ev: PointerEvent) => {
    if (timer !== null && Math.hypot(ev.clientX - at.x, ev.clientY - at.y) > HOLD_SLOP) { window.clearTimeout(timer); timer = null; }
  };
  const lift = () => { const wasHolding = timer === null; stop(); if (!wasHolding) hooks.onTap(); };
  document.addEventListener('pointermove', move, true);
  document.addEventListener('pointerup', lift, true);
  document.addEventListener('pointercancel', lift, true);
  return stop;
}

/** A long press on a phone also asks for the browser's own menu: it is not the menu here. */
export function swallowTouchMenu(e: React.MouseEvent, holding: boolean): boolean {
  if (!holding && !echo()) return false;
  e.preventDefault();
  return true;
}
