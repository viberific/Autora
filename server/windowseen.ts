/**
 * Whether the page has a window on screen.
 *
 * A tool may not say a window is open until the page that mounts it has answered. On 2026-11-20 office_open reported
 * "Parenting-Proposal.docx is open in the Autora Pages window" six times while the person's canvas was blank, and
 * nothing he or the agent tried brought a window up: the server had opened the document, and no page had ever put it
 * on screen. So the page says which windows it has (src/components/OfficeWindow.tsx, SpectraWindow.tsx), a tool that
 * opens one waits for that answer, and a window nobody confirmed is reported as a failure the agent can act on.
 *
 * Nothing here is kept: it is about this page, now, so it lives in memory and is forgotten with the process.
 */
const seenAt = new Map<string, number>();

/** How long a tool waits for the page to confirm a window before it says it could not. */
const WINDOW_WAIT_MS = 2500;

/** A window's name on the page: its app and the chat it is beside. */
const windowKey = (kind: string, session: string) => `${kind}|${session}`;

/** The page has this window up, as of now. */
export function markSeen(kind: string, session: string): void {
  seenAt.set(windowKey(kind, session), Date.now());
}

/**
 * Wait for the page to say it has the window, and answer whether it did. `since` is when the tool asked for it: a
 * report from before that proves nothing about the window the tool has just opened.
 */
export async function waitSeen(kind: string, session: string, since = Date.now(), ms = WINDOW_WAIT_MS): Promise<boolean> {
  for (;;) {
    if ((seenAt.get(windowKey(kind, session)) ?? 0) >= since) return true;
    if (Date.now() - since >= ms) return false;
    await new Promise((r) => setTimeout(r, 60));
  }
}

/** What to tell the agent when a window it opened never appeared, and what to do instead of pretending. */
export function notShownLine(what: string, where: string, ms = WINDOW_WAIT_MS): string {
  return `${what} is loaded and ready in ${where}, but this chat's page never put the window on screen, so the person cannot see it` +
    ` (waited ${Math.round(ms / 100) / 10}s for the page to say it had it). The usual cause is a browser tab running an older` +
    ` build of Autora, which needs reloading once; the other is the window having been shut in the canvas. Do not tell the` +
    ` person it is open: say the file is loaded but its window did not appear, ask them to reload the page, and then open it again.`;
}
