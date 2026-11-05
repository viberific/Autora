/**
 * A document's operation log: every change to its tree as a ProseMirror step with the step that undoes it, who made it and a
 * line saying what it did (docs/PANACEA-ENGINE.md, section 2). It is what a history list reads, and it lets one step be taken
 * back on its own, with the later steps kept: the inverse is moved through what came after it, and refused in words if what
 * it touched has since changed.
 *
 * Shared by the server (which keeps the log: the page's own copy of the document carries only the tree) and the tests, so
 * written without DOM or Node types.
 */
import { Mapping, ReplaceStep, Step } from "prosemirror-transform";
import type { Node as PMNode } from "prosemirror-model";
import { schema } from "./document";

type Author = "agent" | "person";

export interface DocOp {
  /** Order in this document's log, from 1. */
  n: number;
  who: Author;
  at: number;
  summary: string;
  step: unknown;
  /** The step that undoes it, made against the document it applied to. */
  inverse: unknown;
}

export interface DocLog {
  next: number;
  ops: DocOp[];
}

/** The most steps a log keeps, and how long a person's typing counts as one step. */
export const MAX_OPS = 200;
export const TYPING_MS = 5000;

const MAX_SUMMARY = 160;
const clip = (s: string) => (s.length > MAX_SUMMARY ? `${s.slice(0, MAX_SUMMARY - 1)}…` : s);

/** One step that turns `before` into `after` (the span between where they first and last differ), and the one that undoes it. */
export function stepBetween(before: PMNode, after: PMNode): { step: Step; inverse: Step } | null {
  const start = before.content.findDiffStart(after.content);
  if (start === null) return null;
  const end = before.content.findDiffEnd(after.content);
  if (!end) return null;
  let { a: endA, b: endB } = end;
  const overlap = start - Math.min(endA, endB);
  if (overlap > 0) {
    endA += overlap;
    endB += overlap;
  }
  const step = new ReplaceStep(start, endA, after.slice(start, endB));
  const result = step.apply(before);
  if (!result.doc || !result.doc.eq(after)) return null;
  return { step, inverse: step.invert(before) };
}

/** What changed between two documents, in a few words: words added or removed, or that it was formatting. */
function describeChange(before: PMNode, after: PMNode): string {
  const words = (d: PMNode) => (d.textBetween(0, d.content.size, " ", " ").match(/\S+/g) ?? []).length;
  const gained = words(after) - words(before);
  if (gained > 0) return `+${gained} word${gained === 1 ? "" : "s"}`;
  if (gained < 0) return `${gained} word${gained === -1 ? "" : "s"}`;
  return before.textContent === after.textContent ? "formatting" : "reworded";
}

/**
 * The log with this change on the end. A person's typing within a few seconds of their last step joins it (one step, not one
 * per keystroke). Nothing is recorded when the trees are equal.
 */
export function record(log: DocLog | undefined, before: PMNode, after: PMNode, who: Author, summary: string, now = Date.now()): DocLog {
  const base: DocLog = log ?? { next: 1, ops: [] };
  const made = stepBetween(before, after);
  if (!made) return base;
  const last = base.ops[base.ops.length - 1];
  if (last && who === "person" && last.who === "person" && now - last.at < TYPING_MS) {
    try {
      const earlier = Step.fromJSON(schema, last.inverse).apply(before).doc;
      const joined = earlier ? stepBetween(earlier, after) : null;
      if (joined) {
        const ops = base.ops.slice(0, -1);
        ops.push({ ...last, at: now, summary: clip(summary || describeChange(earlier!, after)), step: joined.step.toJSON(), inverse: joined.inverse.toJSON() });
        return { next: base.next, ops };
      }
    } catch {
      // The last step does not fit what is there now: this one stands on its own.
    }
  }
  const op: DocOp = { n: base.next, who, at: now, summary: clip(summary || describeChange(before, after)), step: made.step.toJSON(), inverse: made.inverse.toJSON() };
  const ops = [...base.ops, op];
  if (ops.length > MAX_OPS) ops.shift();
  return { next: base.next + 1, ops };
}

/**
 * The document with step `n` taken out and every later step kept. The inverse of `n` is moved through the steps after it; when
 * what it touched has since been deleted or rewritten it cannot be, and the reason says so.
 */
export function undoOp(doc: PMNode, log: DocLog, n: number): { doc: PMNode } | { error: string } {
  const at = log.ops.findIndex((o) => o.n === n);
  if (at < 0) return { error: `Step ${n} is not in this document's log any more.` };
  try {
    const original = Step.fromJSON(schema, log.ops[at]!.step);
    // Where this step's own words sit, followed through every later step: if one of those touched them, taking this step out
    // would stitch the old text back into something that has been rewritten, so it is refused.
    let lo = original instanceof ReplaceStep ? original.from : 0;
    let hi = original instanceof ReplaceStep ? original.from + original.slice.size : 0;
    const later = new Mapping();
    for (const o of log.ops.slice(at + 1)) {
      const map = Step.fromJSON(schema, o.step).getMap();
      let touched = false;
      map.forEach((oldStart, oldEnd) => {
        if (oldStart < hi && oldEnd > lo) touched = true;
        else if (oldStart === oldEnd && oldStart > lo && oldStart < hi) touched = true;
      });
      if (touched) return { error: "Something later changed those words, so that step cannot be taken out on its own. Undo the later steps first." };
      lo = map.map(lo, 1);
      hi = map.map(hi, -1);
      later.appendMap(map);
    }
    const moved = Step.fromJSON(schema, log.ops[at]!.inverse).map(later);
    if (!moved) return { error: "Something later changed those words, so that step cannot be taken out on its own. Undo the later steps first." };
    const result = moved.apply(doc);
    if (!result.doc) return { error: `That step cannot be taken out now: ${result.failed ?? "the text is different"}.` };
    return { doc: result.doc };
  } catch {
    return { error: "That step cannot be taken out now: the document has changed too much since." };
  }
}

/** The log as it is read back from disk or sent to the page: checked, and cut to what is kept. */
export function readLog(raw: unknown): DocLog | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as { next?: unknown; ops?: unknown };
  if (!Array.isArray(r.ops) || !Number.isInteger(r.next)) return undefined;
  const ops = r.ops
    .filter((o): o is DocOp => !!o && typeof o === "object" && Number.isInteger((o as DocOp).n) && ((o as DocOp).who === "agent" || (o as DocOp).who === "person") && typeof (o as DocOp).summary === "string" && !!(o as DocOp).step && !!(o as DocOp).inverse)
    .slice(-MAX_OPS);
  return { next: Number(r.next), ops };
}

/** What the page lists: no steps, only who, when and what. */
export function listOps(log: DocLog | undefined): { n: number; who: Author; at: number; summary: string }[] {
  return (log?.ops ?? []).map(({ n, who, at, summary }) => ({ n, who, at, summary }));
}
