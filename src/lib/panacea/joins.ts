/**
 * Joins: the person dragged one app's window onto another's and let go, saying "this belongs in that". Unlike a flow
 * (flows.ts: a dashed arrow the app draws by itself when one app's file was used by another), a join is made by the
 * person, is drawn as a thick solid connector between the two windows, and is live: the work of the first is shown in
 * the second and kept up to date there (server/officejoin.ts). It stays until the person unjoins it.
 *
 * Phase 1 has one direction: a spreadsheet (Autora Sheets) joined into a document (Autora Pages), whose table then
 * follows the sheet. A pair not in `JOINABLE` is not offered.
 *
 * Pure: plain JSON in and out, saved with the canvas (canvas.ts), shared by the server and the page.
 */

export interface Join {
  /** The window whose work goes in, and the window it goes into: board ids, `engine:<mode>`. */
  from: string;
  to: string;
  at: number;
}

/** Which window can be joined into which. */
const JOINABLE: Readonly<Record<string, readonly string[]>> = {
  "engine:sheets": ["engine:pages"],
};

const MAX_JOINS = 16;

export function canJoin(from: string, to: string): boolean {
  return from !== to && (JOINABLE[from]?.includes(to) ?? false);
}

/** The mark a joined table carries in the document it went into (its alt-text description), to be found again. */
export const joinMark = (from: string) => `autora-join:${from}`;

export function readJoins(raw: unknown): Join[] {
  if (!Array.isArray(raw)) return [];
  const out: Join[] = [];
  for (const item of raw.slice(0, MAX_JOINS)) {
    const r = item as Record<string, unknown> | null;
    const from = typeof r?.from === "string" ? r.from : "";
    const to = typeof r?.to === "string" ? r.to : "";
    if (!canJoin(from, to) || out.some((j) => j.from === from && j.to === to)) continue;
    out.push({ from, to, at: typeof r?.at === "number" && Number.isFinite(r.at) ? r.at : 0 });
  }
  return out;
}

/** The join made; the same two windows joined again is the same join. */
export function addJoin(list: readonly Join[], join: Join): Join[] {
  if (!canJoin(join.from, join.to)) return [...list];
  return [...list.filter((j) => !(j.from === join.from && j.to === join.to)), join].slice(-MAX_JOINS);
}

export function removeJoin(list: readonly Join[], from: string, to: string): Join[] {
  return list.filter((j) => !(j.from === from && j.to === to));
}

/** What letting go does, said on the window it would go into while a window is held over it. */
const OFFERS: Readonly<Record<string, string>> = {
  "engine:sheets>engine:pages": "Let go to join: this sheet's table goes into the document, and follows the sheet",
};
export const joinOffer = (from: string, to: string): string => OFFERS[`${from}>${to}`] ?? "Let go to join";
