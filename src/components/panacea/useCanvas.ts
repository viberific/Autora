import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { newCanvas, normalizeCanvas, type Canvas } from "../../lib/panacea/canvas";
import { onPanaceaState, panaceaStateNow } from "../../lib/panacea";
import { readCanvasResponse } from "../../lib/panacea/canvasResponse";

type SaveState = "saved" | "saving" | "error";

/** One step of the history: the canvas before it, and what it was. */
export interface Step {
  canvas: Canvas;
  label: string;
  by: "person" | "agent";
  at: number;
}

export type Edit = (draft: Canvas) => void;
/** Change the canvas. `label` names the step in the history; `key` joins a quick run of one kind of edit (a slider) into one step. */
export type Editor = (fn: Edit, label: string, key?: string) => void;

const HISTORY = 120;

/**
 * The canvas in the browser: edited here, kept on the server (server/panacea.ts) where the agent works on it too.
 *
 *   - `edit` changes a copy, remembers the old one as a named step, and saves after a pause;
 *   - when the agent changes the canvas the server says so and the new one is loaded, as a step of its own, so the
 *     person can take any of the agent's changes back;
 *   - the history is one track of every step, the person's and the agent's: `scrub` moves along it;
 *   - while something is being dragged (`hold`), an agent's change waits for the pointer to come up.
 */
export function useCanvas(sessionId: string, enabled = true) {
  const [canvas, setCanvas] = useState<Canvas>(() => newCanvas());
  const [ready, setReady] = useState(false);
  const [save, setSave] = useState<SaveState>("saved");
  const [notice, setNotice] = useState<string | null>(null);
  /** Panels the agent just placed or changed: lit for a moment. */
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const [track, setTrack] = useState<{ past: Step[]; future: Step[] }>({ past: [], future: [] });
  const live = useRef(canvas);
  const past = useRef<Step[]>([]);
  const future = useRef<Step[]>([]);
  const known = useRef(-1);
  const holding = useRef(0);
  const waiting = useRef(false);
  const lastKey = useRef<{ key: string; at: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saving = useRef(false);
  const dirty = useRef(false);
  const localRevision = useRef(0);
  const freshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The first load is where the canvas starts, not a step. */
  const ready_ = useRef(false);

  const base = `/api/panacea/${encodeURIComponent(sessionId)}`;

  const put = useCallback((next: Canvas) => {
    live.current = next;
    setCanvas(next);
  }, []);

  const sync = () => setTrack({ past: [...past.current], future: [...future.current] });

  const remember = (step: Step) => {
    past.current.push(step);
    if (past.current.length > HISTORY) past.current.shift();
  };

  const flush = useCallback(async () => {
    if (saving.current) return;
    saving.current = true;
    try {
      while (dirty.current) {
        dirty.current = false;
        setSave("saving");
        const res = await fetch(`${base}/doc`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ doc: live.current, rev: known.current }),
        });
        const body = (await res.json().catch(() => null)) as { rev?: number; error?: string } | null;
        if (res.status === 409) {
          // The agent changed the canvas since this window last loaded it: take theirs rather than undo it unseen.
          waiting.current = false;
          dirty.current = false;
          const got = (await fetch(`${base}/doc`).then((r) => r.json()).catch(() => null)) as { doc?: unknown; rev?: number } | null;
          const doc = normalizeCanvas(got?.doc);
          if (doc) {
            remember({ canvas: live.current, label: "Your last change", by: "person", at: Date.now() });
            future.current = [];
            known.current = Number(got?.rev ?? known.current);
            put(doc);
            sync();
          }
          setNotice("Autora changed the canvas while you were working, so your last change was not kept. Undo brings it back.");
          setSave("saved");
          return;
        }
        if (!res.ok) throw new Error(body?.error ?? `Autora answered ${res.status}`);
        known.current = Math.max(known.current, Number(body?.rev ?? 0));
        setSave(dirty.current ? "saving" : "saved");
      }
    } catch (err) {
      setSave("error");
      setNotice(`Your last change was not saved: ${err instanceof Error ? err.message : String(err)}`);
      dirty.current = true;
    } finally {
      saving.current = false;
    }
  }, [base, put]);

  const schedule = useCallback(() => {
    dirty.current = true;
    setSave("saving");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), 350);
  }, [flush]);

  /** The canvas as the server has it, taken in. `mark` says the agent made the change: a step, and what it touched lit. */
  const load = useCallback(async (mark: boolean, strict = false) => {
    const beganAt = localRevision.current;
    try {
      const res = await fetch(`${base}/doc`);
      const { doc, rev } = await readCanvasResponse(res);
      // An older startup/refresh reply cannot replace work made while it was in flight.
      if (localRevision.current !== beganAt) return;
      const before = live.current;
      known.current = rev;
      if (JSON.stringify(before) !== JSON.stringify(doc) && ready_.current) {
        remember({ canvas: before, label: agentLabel(before, doc), by: "agent", at: Date.now() });
        future.current = [];
        sync();
        if (mark) {
          const was = new Map(before.panels.map((p) => [p.id, JSON.stringify(p)]));
          const hit = new Set(doc.panels.filter((p) => was.get(p.id) !== JSON.stringify(p)).map((p) => p.id));
          if (hit.size) {
            setFresh(hit);
            if (freshTimer.current) clearTimeout(freshTimer.current);
            freshTimer.current = setTimeout(() => setFresh(new Set()), 2200);
          }
        }
      }
      put(doc);
      ready_.current = true;
      setReady(true);
      setNotice((previous) => previous?.startsWith("The canvas could not be loaded:") ? null : previous);
    } catch (err) {
      setNotice(`The canvas could not be loaded: ${err instanceof Error ? err.message : String(err)}`);
      if (strict) throw err;
    }
  }, [base, put]);

  useEffect(() => {
    if (enabled) void load(false);
  }, [load, enabled]);

  useEffect(
    () =>
      onPanaceaState(() => {
        if (!enabled) return;
        const now = panaceaStateNow();
        if (!now.open || now.rev === undefined) return;
        if (now.by === "agent" && now.rev > known.current) {
          if (holding.current > 0) waiting.current = true;
          else void load(now.quiet !== now.rev);
        } else known.current = Math.max(known.current, now.rev);
      }),
    [load, enabled],
  );

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
    if (freshTimer.current) clearTimeout(freshTimer.current);
    if (dirty.current) void flush();
  }, [flush]);

  const edit: Editor = useCallback((fn, label, key) => {
    const next = structuredClone(live.current);
    fn(next);
    if (JSON.stringify(next) === JSON.stringify(live.current)) return;
    localRevision.current += 1;
    const now = Date.now();
    const joined = key && lastKey.current?.key === key && now - lastKey.current.at < 900;
    lastKey.current = key ? { key, at: now } : null;
    if (!joined) remember({ canvas: live.current, label, by: "person", at: now });
    future.current = [];
    sync();
    put(next);
    schedule();
  }, [put, schedule]);

  /** A change that is not a step of its own (a recipe id written on a panel, a ghost drifting off). */
  const quietly = useCallback((fn: Edit) => {
    const next = structuredClone(live.current);
    fn(next);
    localRevision.current += 1;
    put(next);
    schedule();
  }, [put, schedule]);

  const undo = useCallback(() => {
    const back = past.current.pop();
    if (!back) return;
    future.current.push({ ...back, canvas: live.current });
    lastKey.current = null;
    put(back.canvas);
    sync();
    schedule();
  }, [put, schedule]);

  const redo = useCallback(() => {
    const next = future.current.pop();
    if (!next) return;
    past.current.push({ ...next, canvas: live.current });
    lastKey.current = null;
    put(next.canvas);
    sync();
    schedule();
  }, [put, schedule]);

  /** Move to the point in the history after `n` steps (0 is before the first one). */
  const scrub = useCallback((n: number) => {
    const target = Math.max(0, Math.min(n, past.current.length + future.current.length));
    let moved = false;
    while (past.current.length > target) {
      const back = past.current.pop()!;
      future.current.push({ ...back, canvas: live.current });
      live.current = back.canvas;
      moved = true;
    }
    while (past.current.length < target && future.current.length) {
      const next = future.current.pop()!;
      past.current.push({ ...next, canvas: live.current });
      live.current = next.canvas;
      moved = true;
    }
    if (!moved) return;
    lastKey.current = null;
    put(live.current);
    sync();
    schedule();
  }, [put, schedule]);

  const hold = useCallback((on: boolean) => {
    holding.current = Math.max(0, holding.current + (on ? 1 : -1));
    if (holding.current === 0 && waiting.current) {
      waiting.current = false;
      void load(true);
    }
  }, [load]);

  const dismiss = useCallback(() => setNotice(null), []);

  const saveNow = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    for (let waited = 0; saving.current && waited < 30_000; waited += 100) await new Promise((r) => setTimeout(r, 100));
    if (dirty.current) await flush();
  }, [flush]);
  const refresh = useCallback(() => load(false, true), [load]);

  return useMemo(
    () => ({ canvas, live, ready, save, notice, fresh, track, edit, quietly, undo, redo, scrub, hold, dismiss, saveNow, refresh, canUndo: track.past.length > 0, canRedo: track.future.length > 0 }),
    [canvas, ready, save, notice, fresh, track, edit, quietly, undo, redo, scrub, hold, dismiss, saveNow, refresh],
  );
}

/** What an agent's change did, in a few words, for its step in the history. */
function agentLabel(before: Canvas, after: Canvas): string {
  const added = after.panels.filter((p) => !before.panels.some((b) => b.id === p.id));
  const gone = before.panels.filter((p) => !after.panels.some((a) => a.id === p.id));
  const surfaces = after.surfaces.filter((s) => !before.surfaces.some((b) => b.id === s.id));
  if (surfaces.length) return `Autora added ${surfaces[0]!.title}`;
  if (added.length) return `Autora ${added[0]!.state === "ghost" ? "offered" : "placed"} ${added[0]!.title}${added.length > 1 ? ` and ${added.length - 1} more` : ""}`;
  if (gone.length) return `Autora put away ${gone[0]!.title}`;
  return "Autora changed values";
}
