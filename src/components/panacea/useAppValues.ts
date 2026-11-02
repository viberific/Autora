import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Value } from "../../lib/panacea/atoms";
import { MUSIC_TRACK, isMusicBind, musicOptions, readMusic, writeMusic } from "../../lib/panacea/apps/music";
import type { Node } from "../../lib/panacea/recipe";
import { useStudioState } from "../../lib/studio";
import { normalizeProject, type Project } from "../../lib/studio/model";

/** A value that lives in an app, not on the canvas (the track picked for a panel is the canvas's). */
export const isAppBind = (bind: string) => isMusicBind(bind) && bind !== MUSIC_TRACK;

/** Whether any of these trees has a control on an app's value (only then is the app's state fetched). */
export function wantsMusic(trees: Node[]): boolean {
  const walk = (n: Node): boolean => (!!n.bind && isMusicBind(n.bind)) || !!n.children?.some(walk);
  return trees.some(walk);
}

/**
 * The apps a panel can drive, as the board sees them (src/lib/panacea/apps/): for now the song in Autora Music. A
 * panel's `music.*` control reads the song and moves it; the change shows at once and goes to the server, which applies
 * it to the song (and the Music window takes it from there). What the server says back is the truth: the song is fetched
 * again once nothing is waiting to be sent.
 */
export function useAppValues(sessionId: string, wanted: boolean, onProblem: (text: string) => void) {
  const base = `/api/studio/${encodeURIComponent(sessionId)}`;
  const [song, setSong] = useState<{ doc: Project; focus: string | null } | null>(null);
  const studio = useStudioState();
  const queue = useRef(new Map<string, { value: Value; track: unknown }>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const busy = useRef(0);

  const load = useCallback(async () => {
    if (busy.current || queue.current.size) return;
    const body = (await fetch(`${base}/doc`).then((r) => (r.ok ? r.json() : null)).catch(() => null)) as { doc?: unknown; focus?: { trackId?: string | null } } | null;
    const doc = normalizeProject(body?.doc);
    if (doc && !busy.current && !queue.current.size) setSong({ doc, focus: body?.focus?.trackId ?? null });
  }, [base]);

  // Again whenever the song moves on (the window, the agent, another tab).
  useEffect(() => { if (wanted) void load(); }, [wanted, load, studio.rev, studio.open]);

  const flush = useCallback(async () => {
    timer.current = null;
    const sends = [...queue.current];
    queue.current.clear();
    busy.current++;
    try {
      for (const [bind, { value, track }] of sends) {
        const res = await fetch(`${base}/panel`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bind, value, track }) }).catch(() => null);
        const body = (await res?.json().catch(() => null)) as { error?: string } | null;
        if (!res?.ok) onProblem(body?.error ? `Music did not take that: ${body.error}.` : "Could not reach Autora Music. Try again.");
      }
    } finally {
      busy.current--;
      void load();
    }
  }, [base, load, onProblem]);

  /** A control moved: shown now, sent once the drag settles a little (the latest value of each control wins). */
  const write = useCallback((bind: string, value: Value, track: unknown) => {
    setSong((s) => {
      if (!s) return s;
      const doc = structuredClone(s.doc);
      return "error" in writeMusic(doc, bind, value, track, s.focus) ? s : { ...s, doc };
    });
    queue.current.set(bind, { value, track });
    if (!timer.current) timer.current = setTimeout(() => void flush(), 120);
  }, [flush]);

  useEffect(() => () => { if (timer.current) { clearTimeout(timer.current); void flush(); } }, [flush]);

  /** The value a control shows: off the song for an app value, else undefined (the caller reads the canvas). */
  const read = useCallback((bind: string, picked: unknown): Value | undefined => {
    if (!song || !isMusicBind(bind)) return undefined;
    return readMusic(song.doc, bind, picked, song.focus);
  }, [song]);

  const options = useCallback((source: string) => (source === "tracks" && song ? musicOptions(song.doc) : []), [song]);

  return useMemo(() => ({ read, write, options }), [read, write, options]);
}
