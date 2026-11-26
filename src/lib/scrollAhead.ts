/**
 * Scroll the person has asked of the live browser that its picture does not show yet.
 *
 * The page scrolls on the server and only the next picture shows it, so a finger dragging the page saw it move a few
 * times a second. The card instead moves the picture it has by this much at once, and takes each part back as the
 * picture catches up: asked for and not sent yet (`ask`), on its way (`take`), or done on the server (`landed`, with the
 * server's time) until a picture sent after that time is on the screen (`frame`). Chrome sends no picture when nothing on
 * the page changed (a scroll past the end), so a landed part with no picture after it is let go after `LANDED_MS`.
 */
type Delta = { dx: number; dy: number };

/** How long a scroll that landed keeps the picture moved when no newer picture comes. */
export const LANDED_MS = 600;
/** The picture is never moved by more than this share of the page's view: past it, it waits for the server. */
const MOST = 0.6;

export class ScrollAhead {
  private queued: Delta = { dx: 0, dy: 0 };
  private inflight: Delta | null = null;
  private done: Array<Delta & { at: number; seen: number }> = [];

  /** The finger or wheel asked for this much more. */
  ask(dx: number, dy: number) {
    this.queued = { dx: this.queued.dx + dx, dy: this.queued.dy + dy };
  }

  /** Whether there is enough asked for to send. */
  waiting(): boolean {
    return Math.abs(this.queued.dx) + Math.abs(this.queued.dy) >= 1;
  }

  /** Whether a scroll is on its way. */
  flying(): boolean {
    return this.inflight !== null;
  }

  /** What to send now, or null: nothing asked for, or one already on its way. */
  take(): Delta | null {
    if (this.inflight || !this.waiting()) return null;
    this.inflight = this.queued;
    this.queued = { dx: 0, dy: 0 };
    return { ...this.inflight };
  }

  /** The scroll on its way was done on the server at `at` (its clock), or refused (null: the picture takes it back). */
  landed(at: number | null, now = Date.now()) {
    if (this.inflight && at !== null) this.done.push({ ...this.inflight, at, seen: now });
    this.inflight = null;
  }

  /** A picture sent at `ts` (the server's clock) is on the screen. Whether that changed how far the picture is moved. */
  frame(ts: number): boolean {
    const before = this.done.length;
    this.done = this.done.filter((d) => d.at > ts);
    return this.done.length !== before;
  }

  /** How far to move the picture, in page pixels, at most `MOST` of the view each way. */
  offset(w: number, h: number, now = Date.now()): Delta {
    this.done = this.done.filter((d) => now - d.seen < LANDED_MS);
    let dx = this.queued.dx + (this.inflight?.dx ?? 0);
    let dy = this.queued.dy + (this.inflight?.dy ?? 0);
    for (const d of this.done) { dx += d.dx; dy += d.dy; }
    const clamp = (v: number, most: number) => Math.max(-most, Math.min(most, v));
    return { dx: clamp(dx, w * MOST), dy: clamp(dy, h * MOST) };
  }

  /** Whether anything still moves the picture (something to look at again once `LANDED_MS` has passed). */
  pending(): boolean {
    return this.waiting() || this.inflight !== null || this.done.length > 0;
  }
}
