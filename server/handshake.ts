/**
 * The handshake between the server and an editor's window, which every editor used to carry its own copy of (3D, Photo, PDF,
 * Office, Music, Panacea, Video): the server offers a call to the window by pushing a message with an id, sends it again
 * until a window takes it (a tab that has only just mounted lets the first one go by, and the same chat in two tabs hears it
 * twice: the first to claim does it, once), then waits for the window's reply, a timeout or a cancel.
 *
 * Each editor keeps what is its own: the message it pushes, the shape of the reply, its routes (which call `claim`, `reply`
 * and `fail` here) and what a timeout means for it. See docs/ENGINE-SURVEY.md, finding 2.
 */
import crypto from "node:crypto";

/** What an offer comes to: nobody took it, or a window did and this is what it said. */
type Taken<R> = { taken: false } | { taken: true; value: R };

/** A timeout that is read as "no window took it", for the callers that fall back to doing the call here. */
export const UNTAKEN = Symbol("untaken");

interface OfferOptions<R> {
  /** Give up if no window has claimed it by then (the call is then done here instead). Without it, an unclaimed call waits for `totalMs`. */
  claimMs?: number;
  /** How often it is pushed again while nobody has claimed it. Default 1 s. */
  resendMs?: number;
  /** The most time from the offer, claimed or not. */
  totalMs?: number;
  /** The most time from the claim: a hand works at a person's pace, so this is counted from when it started. */
  replyMs?: number;
  /** What a timeout comes to: a reply made up here, or UNTAKEN. Without it a timeout rejects with `timeoutError`. */
  onTimeout?: () => R | typeof UNTAKEN;
  timeoutError?: string;
  /** Handed to the window with its claim (the model a hand should end at, what it must wait for). */
  info?: unknown;
  /** Runs once, when a window has claimed it. */
  onClaimed?: () => void;
}

interface Pending {
  session: string;
  claimed: boolean;
  info?: unknown;
  resolve: (r: Taken<unknown>) => void;
  reject: (e: Error) => void;
  stop: () => void;
  /** Runs when a window claims it: the reply clock starts there. */
  onClaim?: () => void;
}

export function createHandshake() {
  const pending = new Map<string, Pending>();
  let push: (session: string, message: Record<string, unknown>) => void = () => undefined;

  return {
    /** Where messages go: the chat's open pages. Set when the editor's routes are registered. */
    setPush(fn: (session: string, message: Record<string, unknown>) => void) {
      push = fn;
    },

    /** Offers a call to the window and waits. Rejects on a timeout (unless `onTimeout` answers it), a cancel or `fail`. */
    offer<R>(session: string, message: Record<string, unknown>, o: OfferOptions<R> = {}): Promise<Taken<R>> {
      const id = crypto.randomBytes(6).toString("hex");
      return new Promise<Taken<R>>((resolve, reject) => {
        const timers: NodeJS.Timeout[] = [];
        const resend: { timer?: NodeJS.Timeout } = {};
        const entry: Pending = {
          session,
          claimed: false,
          info: o.info,
          resolve: (r) => { entry.stop(); resolve(r as Taken<R>); },
          reject: (e) => { entry.stop(); reject(e); },
          stop: () => {
            clearInterval(resend.timer);
            timers.forEach(clearTimeout);
            pending.delete(id);
          },
        };
        const timedOut = () => {
          const made = o.onTimeout?.();
          if (made === undefined) entry.reject(new Error(o.timeoutError ?? "The window did not answer in time."));
          else if (made === UNTAKEN) entry.resolve({ taken: false });
          else entry.resolve({ taken: true, value: made });
        };
        pending.set(id, entry);
        const send = () => push(session, { ...message, id });
        send();
        resend.timer = setInterval(() => { if (!entry.claimed) send(); }, o.resendMs ?? 1000);
        if (o.claimMs !== undefined) timers.push(setTimeout(() => { if (!entry.claimed) entry.resolve({ taken: false }); }, o.claimMs));
        if (o.totalMs !== undefined) timers.push(setTimeout(timedOut, o.totalMs));
        // The reply clock is counted from the claim, so it is started there (`claim` below calls this).
        entry.onClaim = () => {
          clearInterval(resend.timer);
          o.onClaimed?.();
          if (o.replyMs !== undefined) timers.push(setTimeout(timedOut, o.replyMs));
        };
      });
    },

    /** A window asks to do call `id`: the first to ask wins, once. `info` is what the offer said to hand it. */
    claim(session: string, id: string): { won: boolean; info?: unknown } {
      const p = pending.get(id);
      if (!p || p.session !== session || p.claimed) return { won: false };
      p.claimed = true;
      p.onClaim?.();
      return { won: true, info: p.info };
    },

    /**
     * The window says what it did. False when nothing is waiting for it (not claimed, another chat's, or already over). The
     * command-style editors (Music, Panacea, Video) have always taken a reply that was not claimed first: `unclaimed: true` keeps that.
     */
    reply(session: string, id: string, value: unknown, o: { unclaimed?: boolean } = {}): boolean {
      const p = pending.get(id);
      if (!p || p.session !== session || (!p.claimed && !o.unclaimed)) return false;
      p.resolve({ taken: true, value });
      return true;
    },

    /** The window says it could not. False when nothing is waiting. */
    fail(session: string, id: string, error: Error): boolean {
      const p = pending.get(id);
      if (!p || p.session !== session) return false;
      p.reject(error);
      return true;
    },

    /** The window closed or the chat is gone: everything waiting on it ends. */
    cancelAll(session: string, why: string) {
      for (const [, p] of [...pending]) if (p.session === session) p.reject(new Error(why));
    },

    /** How many calls are waiting (for a chat, or all). */
    waiting(session?: string): number {
      return [...pending.values()].filter((p) => !session || p.session === session).length;
    },
  };
}
