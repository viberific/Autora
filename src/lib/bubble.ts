/**
 * Where Autora's bubble sits while a tool has the whole of a phone's screen (components/ChatBubble.tsx).
 *
 * The bubble is the conversation, shrunk to a button the person can put anywhere: dragged, it follows the finger;
 * let go, it settles on the nearer side of the screen at the height it was dropped, clear of the screen's edges and
 * its notch. Dropped on the close target at the foot of the screen, it ends full screen. The place is remembered for
 * the next tool that goes full screen, as a side and a share of the height, so it survives the phone turning.
 */

export const BUBBLE_SIZE = 56;
/** How far the bubble keeps from the screen's sides and its top and bottom. */
export const BUBBLE_GAP = 10;
/** How near the close target the bubble's centre must be let go for it to count. */
export const CLOSE_REACH = 64;
/** A finger must move this far before a press on the bubble is a drag rather than a tap. */
export const BUBBLE_SLOP = 6;

export type BubbleSpot = { side: "left" | "right"; at: number };
export type Screen = { w: number; h: number; top?: number; bottom?: number };

/** Where it sits the first time: on the right, a little under the middle, above where a thumb types. */
export const DEFAULT_SPOT: BubbleSpot = { side: "right", at: 0.62 };

/** The highest and lowest the bubble's top may be on this screen. */
function band(screen: Screen) {
  const low = BUBBLE_GAP + (screen.top ?? 0);
  const high = Math.max(low, screen.h - BUBBLE_SIZE - BUBBLE_GAP - (screen.bottom ?? 0));
  return { low, high };
}

/** The bubble's top-left corner on this screen. */
export function placeBubble(spot: BubbleSpot, screen: Screen): { x: number; y: number } {
  const { low, high } = band(screen);
  const at = Math.min(1, Math.max(0, Number.isFinite(spot.at) ? spot.at : DEFAULT_SPOT.at));
  return {
    x: spot.side === "left" ? BUBBLE_GAP : Math.max(BUBBLE_GAP, screen.w - BUBBLE_SIZE - BUBBLE_GAP),
    y: Math.round(low + (high - low) * at),
  };
}

/** Where the bubble settles when let go with its top-left corner at x, y: the nearer side, the same height. */
export function settleBubble(x: number, y: number, screen: Screen): BubbleSpot {
  const { low, high } = band(screen);
  const side = x + BUBBLE_SIZE / 2 < screen.w / 2 ? "left" : "right";
  const at = high > low ? (Math.min(high, Math.max(low, y)) - low) / (high - low) : 0;
  return { side, at: Math.round(at * 1000) / 1000 };
}

/** The centre of the close target: the middle of the screen's foot. */
export function closeTarget(screen: Screen): { x: number; y: number } {
  return { x: screen.w / 2, y: screen.h - (screen.bottom ?? 0) - 56 };
}

/** Whether the bubble, its top-left corner at x, y, is over the close target. */
export function overClose(x: number, y: number, screen: Screen): boolean {
  const target = closeTarget(screen);
  return Math.hypot(x + BUBBLE_SIZE / 2 - target.x, y + BUBBLE_SIZE / 2 - target.y) <= CLOSE_REACH;
}

const KEY = "autora.bubble";

export function loadBubble(): BubbleSpot {
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<BubbleSpot> | null;
    if (stored && (stored.side === "left" || stored.side === "right") && typeof stored.at === "number" && Number.isFinite(stored.at)) {
      return { side: stored.side, at: Math.min(1, Math.max(0, stored.at)) };
    }
  } catch { /* not remembered: the default */ }
  return DEFAULT_SPOT;
}

export function saveBubble(spot: BubbleSpot) {
  try { localStorage.setItem(KEY, JSON.stringify(spot)); } catch { /* not remembered */ }
}
