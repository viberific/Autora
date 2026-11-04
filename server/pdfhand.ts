/**
 * The agent's hand in the PDF window (Visible work: docs/VISIBLE-WORK.md).
 *
 * With Visible work on and the PDF window open, what `pdf_edit` can do with the editor's own tools (text, notes,
 * highlights, shapes, lines, stamps, drawn marks, form fields) is not drawn onto the file here: it is handed to the
 * window, the first window of the chat to claim it does it there, live, by hand (spectra-editor/src/autora/hand.ts),
 * and presses Save; that save comes back to the desk as the agent's change (`expectHandSave` in pdfdesk.ts). The tool
 * call waits for all of it, so what the agent is told it did is what the person watched happen.
 *
 * No window claims it within a few seconds (none open, or nobody has the page) -> nobody is watching, and the edit is
 * done here at speed as with Visible work off.
 */
import express, { type Express, type Request, type Response } from "express";
import { deskState, expectHandSave } from "./pdfdesk";
import { createHandshake } from "./handshake";

export type HandStep = { kind: "field" | "add"; key: string | number; ok: boolean; skipped?: boolean; error?: string; what?: string; page?: number };
export type HandJob = { fields?: Record<string, unknown>; add?: Array<Record<string, unknown> & { i: number }> };
/** What the window did: each step, and whether its save reached the desk. */
export type HandReply = { steps: HandStep[]; saved: boolean; error?: string };

let visible: () => boolean = () => false;

/** The offers to the window (server/handshake.ts). */
const hs = createHandshake();

/** How long a window has to take the edit before it is done here instead. */
const CLAIM_MS = 4_000;
/** A person's pace: time to find each tool, scroll, draw and type, and for the editor to start if it is starting. */
const handTime = (steps: number) => 60_000 + steps * 25_000;
/** How long the editor's save may take to reach the desk after the hand pressed it. */
const SAVE_MS = 30_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The edit, done in the window by the agent's hand; null when no window took it (nobody is watching). */
export async function handToWindow(session: string, job: HandJob, label: string): Promise<HandReply | null> {
  if (!visible() || !deskState(session).open) return null;
  let save: ReturnType<typeof expectHandSave> | null = null;
  try {
    // A window that has only just mounted lets the first one go by: it is sent again until one takes it, or nobody does.
    const steps = (job.add?.length ?? 0) + Object.keys(job.fields ?? {}).length;
    const out = await hs.offer<HandReply>(session, { type: "pdfdesk.hand", session, job }, {
      claimMs: CLAIM_MS,
      replyMs: handTime(steps),
      // From the claim the window's next save is the hand's.
      onClaimed: () => { save = expectHandSave(session, label); },
      onTimeout: () => ({ steps: [], saved: false, error: "the window took too long; what it did is in the window" }),
    });
    if (!out.taken) return null;
    const reply = out.value;
    let saved = false;
    if (reply.saved && save) saved = await Promise.race([(save as ReturnType<typeof expectHandSave>).saved, sleep(SAVE_MS).then(() => false)]);
    return { steps: reply.steps, saved, ...(reply.error ? { error: reply.error } : {}) };
  } finally {
    (save as ReturnType<typeof expectHandSave> | null)?.end();
  }
}

export function pdfHandRoutes(app: Express, opts: {
  exists: (session: string) => boolean;
  /** Send a message to the chat's open pages (not kept in its log). */
  push: (session: string, message: Record<string, unknown>) => void;
  /** Whether Visible work is on. */
  visible: () => boolean;
}): void {
  hs.setPush(opts.push);
  visible = opts.visible;
  const known = (req: Request, res: Response): string | null => {
    const id = String(req.params.session);
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(id) || !opts.exists(id)) {
      res.status(404).json({ error: "No such session." });
      return null;
    }
    return id;
  };

  /* The first window to ask does the edit. */
  app.post("/api/pdfdesk/:session/hand/claim", (req, res) => {
    const id = known(req, res);
    if (!id) return;
    res.json({ won: hs.claim(id, String(req.query.id ?? "")).won });
  });

  /* ...and says what it did. The file itself comes by the editor's own save. */
  app.post("/api/pdfdesk/:session/hand/reply", express.json({ limit: "256kb" }), (req, res) => {
    const id = known(req, res);
    if (!id) return;
    const body = (req.body ?? {}) as { results?: unknown; saved?: unknown; error?: unknown };
    const steps = (Array.isArray(body.results) ? body.results : []).slice(0, 500).map((r: any): HandStep => ({
      kind: r?.kind === "field" ? "field" : "add",
      key: typeof r?.key === "number" ? r.key : String(r?.key ?? "").slice(0, 200),
      ok: r?.ok === true,
      ...(r?.skipped === true ? { skipped: true } : {}),
      ...(typeof r?.error === "string" ? { error: r.error.slice(0, 400) } : {}),
      ...(typeof r?.what === "string" ? { what: r.what.slice(0, 120) } : {}),
      ...(Number.isInteger(r?.page) && r.page > 0 ? { page: r.page } : {}),
    }));
    const said: HandReply = { steps, saved: body.saved === true, ...(typeof body.error === "string" ? { error: body.error.slice(0, 400) } : {}) };
    if (!hs.reply(id, String(req.query.id ?? ""), said)) return res.status(404).json({ error: "No such edit." });
    res.json({ ok: true });
  });
}
