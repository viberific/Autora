/**
 * The thumbs under a reply: a person's own word on whether the turn worked.
 *
 * The trace and the tool health numbers say what the machinery did -- which
 * call was slow, which one failed. They cannot say whether the answer was
 * any good, which is the only thing that tells a change from an improvement.
 * So this is one click, kept in the chat's own log beside the turn it is
 * about, and read back from there: no other store, and a rating that a
 * reload has to fetch separately is a rating that goes missing.
 *
 * The rule: one rating per reply. A turn can hold several replies (the agent
 * talks, works, talks again), and a thumb is on the one it was pressed under,
 * by that reply's seq (`reply`); a rating written before that has no `reply`
 * and is the whole turn's. A second click replaces the first, and clicking the
 * thumb that is already lit clears it. Where a number per turn is wanted (the
 * digest), a turn's rating is the most recent one still standing in it. A clear has to be written down as something, and it is not
 * a down-vote -- counting it as one would poison exactly the number this
 * exists to produce -- so it is a kind of its own that the counting readers
 * skip.
 */
import type { Express, Request, Response } from "express";
import type { AutoraEvent, Session } from "./session-types";

/** A rating on a reply. `turn` is the seq of the turn's own `turn.user` event, `reply` the seq of the reply. */
const RATING_KIND = "turn.rating";
/** The rating taken back. Carries the turn and nothing else. */
const RATING_CLEAR_KIND = "turn.rating.cleared";

/** One line, because a reason is read in a list and never shown in a box. */
export const MAX_REASON = 280;

type Rating = { up: boolean; reason?: string };

/**
 * What the person typed, as one short line: newlines and control characters
 * gone, whitespace collapsed, cut at MAX_REASON. Never used as a path or in a
 * shell anywhere -- it is only ever a string in a JSON payload -- but keeping
 * it to one short line is what makes it safe to put in front of a reader.
 */
export function cleanReason(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const line = value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!line) return undefined;
  return line.length > MAX_REASON ? `${line.slice(0, MAX_REASON - 1)}…` : line;
}

/** The seqs of every turn in a log: one per `turn.user`. */
function turnSeqs(events: readonly { kind: string; seq: number }[]): Set<number> {
  const out = new Set<number>();
  for (const e of events) if (e.kind === "turn.user") out.add(Number(e.seq));
  return out;
}

/** The reply a rating event is on, or undefined for one on the whole turn (written before replies had their own). */
const replyOf = (p: Record<string, any>) => {
  const reply = Number(p.reply);
  return Number.isInteger(reply) && reply > 0 ? reply : undefined;
};

/**
 * Fold one rating event into the ratings standing in each turn, keyed by reply (0 for the whole turn). A clear
 * on a reply takes back that reply's; one with no reply, the whole turn's. Order of setting is kept, so the
 * last entry is the most recent.
 */
export function foldRating(into: Map<number, Map<number, Rating>>, kind: string, p: Record<string, any>): void {
  const turn = Number(p.turn);
  if (!Number.isInteger(turn) || turn <= 0) return;
  const reply = replyOf(p);
  if (kind === RATING_CLEAR_KIND) {
    if (reply === undefined) into.delete(turn);
    else into.get(turn)?.delete(reply);
    if (into.get(turn)?.size === 0) into.delete(turn);
  } else if (kind === RATING_KIND && typeof p.up === "boolean") {
    const reason = cleanReason(p.reason);
    const standing = into.get(turn) ?? new Map<number, Rating>();
    standing.delete(reply ?? 0);
    standing.set(reply ?? 0, reason ? { up: p.up, reason } : { up: p.up });
    into.set(turn, standing);
  }
}

/** A turn's rating, for counting: the most recent one still standing in it. */
export const turnRating = (standing: Map<number, Rating>): Rating | undefined => [...standing.values()].at(-1);

/**
 * Every turn's rating, last word winning, a clear removing it. Read from the
 * log in order, which is why a replacement needed no rewriting of anything.
 */
export function ratingsFrom(
  events: readonly { kind: string; payload?: Record<string, any> }[],
): Map<number, Rating> {
  const standing = new Map<number, Map<number, Rating>>();
  for (const e of events) foldRating(standing, e.kind, e.payload ?? {});
  const out = new Map<number, Rating>();
  for (const [turn, replies] of standing) {
    const rating = turnRating(replies);
    if (rating) out.set(turn, rating);
  }
  return out;
}

/**
 * The decision the route makes, kept apart from the route so it can be tested
 * without a server: what to write down, or why nothing is written.
 */
type RatingCall =
  | { ok: true; clear: true; turn: number; reply?: number }
  | { ok: true; clear: false; turn: number; reply?: number; up: boolean; reason?: string }
  | { ok: false; status: number; error: string };

export function ratingCall(
  body: unknown,
  turnOf: Set<number>,
): RatingCall {
  const b = (body ?? {}) as Record<string, unknown>;
  const turn = Number(b.turn);
  if (!Number.isInteger(turn) || turn <= 0) {
    return { ok: false, status: 400, error: "Which turn? Give the turn's number." };
  }
  /* The turn has to be one of this chat's: a rating on a turn that is not here
     would attach to nothing, and would count in a digest for a conversation it
     never happened in. */
  if (!turnOf.has(turn)) return { ok: false, status: 404, error: "That turn is not in this chat." };
  /* The reply it is on, when the page says: after the turn's prompt, never before it. */
  let on: { reply?: number } = {};
  if (b.reply !== undefined) {
    const reply = Number(b.reply);
    if (!Number.isInteger(reply) || reply <= turn) return { ok: false, status: 400, error: "Which reply? Give the reply's number, after its turn's." };
    on = { reply };
  }
  const clear = b.up === null || b.clear === true;
  if (clear) return { ok: true, clear: true, turn, ...on };
  if (typeof b.up !== "boolean") {
    return { ok: false, status: 400, error: "A rating is up true or false, or null to take it back." };
  }
  const reason = cleanReason(b.reason);
  return reason ? { ok: true, clear: false, turn, ...on, up: b.up, reason } : { ok: true, clear: false, turn, ...on, up: b.up };
}

/** The event a call writes, in the one place both the route and a test look. */
function ratingEvent(call: Extract<RatingCall, { ok: true }>): { kind: string; payload: Record<string, any> } {
  const on = call.reply === undefined ? {} : { reply: call.reply };
  return call.clear
    ? { kind: RATING_CLEAR_KIND, payload: { turn: call.turn, ...on } }
    : { kind: RATING_KIND, payload: { turn: call.turn, ...on, up: call.up, ...(call.reason ? { reason: call.reason } : {}) } };
}

export function ratingRoutes(app: Express, deps: {
  sessions: Map<string, Session>;
  emitEvent: (session: Session, kind: string, actor: string, payload: Record<string, any>) => AutoraEvent;
}) {
  const { sessions, emitEvent } = deps;

  /* POST /api/sessions/:id/rating { turn, reply?, up: true|false|null, reason? }
     Thumbs go through the same emitEvent as every other kind, so the event is
     in the log, on the websocket and in the Logs page like the rest. */
  app.post("/api/sessions/:id/rating", (req: Request, res: Response) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });
    const call = ratingCall(req.body, turnSeqs(session.events));
    if (!call.ok) return res.status(call.status).json({ error: call.error });
    const made = ratingEvent(call);
    emitEvent(session, made.kind, "user", made.payload);
    const rating = call.clear ? null : call.reason ? { up: call.up, reason: call.reason } : { up: call.up };
    res.json({ ok: true, turn: call.turn, ...(call.reply === undefined ? {} : { reply: call.reply }), rating });
  });

  /* GET /api/sessions/:id/ratings -- every rated turn in the chat, for a page
     that opened without the log (a session opened fresh sends its events, so
     this is for readers that only want the ratings). */
  app.get("/api/sessions/:id/ratings", (req: Request, res: Response) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });
    const out: Record<string, Rating> = {};
    for (const [turn, rating] of ratingsFrom(session.events)) out[String(turn)] = rating;
    res.json({ ratings: out });
  });
}
