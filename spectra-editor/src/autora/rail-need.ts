/**
 * What the PDF bar decides about its tools, apart from drawing them: what is open, what the open document gives it to go on, and
 * which tools the work needs now. Plain functions of those, so `tests/pdf-rail.test.ts` runs them without the editor.
 */
import type { Tile } from "./rail-tools";

/* ------------------------------------------------------- what is open now */

export interface Open {
  /** The armed canvas mode (`select` when none). */
  mode: string;
  /** The open tool (Comment, Redact, Protect...), or null. */
  tool: string | null;
  /** Sign is up: Spectra's stamp mode with only the signatures showing (see the `autora-signing` rules in autora.css). */
  signing?: boolean;
  /** The left panel (a desktop's): open or not, and which of Spectra's nav panels it shows. */
  pane?: { open: boolean; panel: string };
  /** What the open document gives the bar to go on. */
  work: Work;
}

/** What the open document has: the bar shows the tools that fit it (see `needed`). */
export interface Work {
  /** A document is open. */
  doc: boolean;
  pages: number;
  /** Marks that are not saved into the file yet: something to select, move or erase. */
  marks: boolean;
  /** Form fields on the pages that are drawn now (a long document draws the pages in view). */
  fields: boolean;
}

export const NO_WORK: Work = { doc: false, pages: 0, marks: false, fields: false };

/** Whether a tile's tool or mode is the one open. */
export const isOn = (t: Tile, open: Open): boolean => (t.id === "sign" ? !!open.signing : t.id === "stamp" ? open.mode === "stamp" && !open.signing : t.mode ? open.mode === t.mode : t.tool ? open.tool === t.tool && open.mode === "select" : t.id === "select" && open.mode === "select" && open.tool === null);

/** What a document is for, once one is open: reading it, marking it up, signing and redacting it, and changing its words. */
const BASE = new Set(["select", "text", "highlight", "draw", "shape", "note", "sign", "redact", "edit"]);

/**
 * Whether the work needs this tool on the bar now (docs/TOOL-RAIL.md, "The bar follows the work"). With no document open nothing is
 * needed. With one, the bar is the tools it is for, and a tool joins when the document has something for it: Erase when there are
 * marks, Fill fields when there are fields, Organize when there is more than one page. A tool in use stays, and so does one the
 * person has reached for in this window (`used`), which is how a specialist tool (Stamps, Callout, Measure...) earns its place.
 * Everything is still in All tools.
 */
export function needed(t: Tile, open: Open, used: ReadonlySet<string>): boolean {
  if (!open.work.doc) return false;
  if (isOn(t, open) || used.has(t.id)) return true;
  if (t.id === "erase") return open.work.marks;
  if (t.id === "forms") return open.work.fields;
  if (t.id === "organize") return open.work.pages > 1;
  return BASE.has(t.id);
}


/** How long what the document had is held after it seems to have gone. */
export const HOLD_MS = 2000;

/**
 * What the bar acts on, steadier than what the editor says from one moment to the next. The editor's state briefly reads as "no
 * document", or "no marks", while it re-renders or reindexes a page after a save, and a bar that took that at its word would fade
 * every tool out and back in (and move the buttons under a pointer on the way). A loss is held for `HOLD_MS`; if the document
 * is still without it after that, it is real. Gains are taken at once. `seen` is the last reading that was not a loss, and when.
 */
export function holdWork(raw: Work, seen: { work: Work; at: number } | null, now: number): { work: Work; seen: { work: Work; at: number } } {
  const lost = !!seen && ((seen.work.doc && !raw.doc) || (seen.work.marks && !raw.marks) || (seen.work.fields && !raw.fields) || raw.pages < seen.work.pages);
  if (!seen || !lost || now - seen.at >= HOLD_MS) return { work: raw, seen: { work: raw, at: now } };
  return { work: seen.work, seen };
}

/* ------------------------------------------------------- what is picked now */

/** What the person has selected, as the agent is told it: the words, and the page they are on (null with nothing selected). */
export function pickWords(selected: string, page: number | null): string {
  const words = selected.replace(/\s+/g, " ").trim().slice(0, 120);
  return words ? (page ? `"${words}" (page ${page})` : `"${words}"`) : "";
}
