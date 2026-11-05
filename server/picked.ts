/**
 * What the person has picked in a tool window (words, a clip, a layer), kept briefly so the agent's next briefing can say it:
 * "make this bigger" then means what they are looking at. Never written to disk. Pages, Sheets and Slides keep theirs in
 * `officedesk.ts` with these same limits; PDF, Video and Photo use `rememberPick` / `pickText`.
 */

/** A pick older than this is no longer what the person is on. */
export const PICK_FRESH_MS = 2 * 60_000;
export const PICK_MAX = 120;

export type Pick = { text: string; at: number };

/** The frame is any page, so the text is cut and tidied before it is kept. */
export const tidyPick = (raw: unknown): string => String(raw ?? "").replace(/\s+/g, " ").trim().slice(0, PICK_MAX);

/** The pick to keep for this report: none for an empty one. */
export const rememberPick = (raw: unknown, now = Date.now()): Pick | undefined => {
  const text = tidyPick(raw);
  return text ? { text, at: now } : undefined;
};

/** The pick's words while it is fresh, else null. */
export const pickText = (pick: Pick | undefined, now = Date.now()): string | null => (pick && now - pick.at < PICK_FRESH_MS ? pick.text : null);
