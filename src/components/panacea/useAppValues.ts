import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Value } from "../../lib/panacea/atoms";
import { MODEL_PART, isModelBind, modelOptions, readModel, type ModelDoc } from "../../lib/panacea/apps/model";
import { MUSIC_TRACK, isMusicBind, musicOptions, readMusic, writeMusic } from "../../lib/panacea/apps/music";
import type { Node } from "../../lib/panacea/recipe";
import { useCadState } from "../../lib/caddesk";
import { useStudioState } from "../../lib/studio";
import { normalizeProject, type Project } from "../../lib/studio/model";

/** A value that lives in an app, not on the canvas (the track or part picked for a panel is the canvas's). */
export const isAppBind = (bind: string) => (isMusicBind(bind) && bind !== MUSIC_TRACK) || (isModelBind(bind) && bind !== MODEL_PART);

/** The apps a panel can drive: for now the song in Autora Music and the model in Autora 3D. */
type AppName = "music" | "model";
const appOf = (bind: string): AppName | null => (isMusicBind(bind) ? "music" : isModelBind(bind) ? "model" : null);

/** Which apps have a control on one of their values in these trees (only then is an app's state fetched). */
export function wantedApps(trees: Node[]): Set<AppName> {
  const out = new Set<AppName>();
  const walk = (n: Node) => { const a = n.bind ? appOf(n.bind) : null; if (a) out.add(a); n.children?.forEach(walk); };
  trees.forEach(walk);
  return out;
}

/**
 * The apps a panel can drive, as the board sees them (src/lib/panacea/apps/). A panel's `music.*` or `model.*` control
 * reads the song or the model and moves it; the change shows at once and goes to the server, which applies it (and the
 * app's window takes it from there). What the server says back is the truth: the app is fetched again once nothing is
 * waiting to be sent.
 */
export function useAppValues(sessionId: string, wanted: Set<AppName>, onProblem: (text: string) => void) {
  const id = encodeURIComponent(sessionId);
  const wantMusic = wanted.has("music");
  const wantModel = wanted.has("model");
  const [song, setSong] = useState<{ doc: Project; focus: string | null } | null>(null);
  const [model, setModel] = useState<ModelDoc | null>(null);
  /** What a model control was just set to, shown until the model is fetched again (the modeller works out the rest). */
  const [shown, setShown] = useState<Record<string, Value>>({});
  const studio = useStudioState();
  const cad = useCadState();
  const queue = useRef(new Map<string, { value: Value; pick: unknown }>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const busy = useRef(0);

  const idle = () => !busy.current && !queue.current.size;

  const loadSong = useCallback(async () => {
    if (!idle()) return;
    const body = (await fetch(`/api/studio/${id}/doc`).then((r) => (r.ok ? r.json() : null)).catch(() => null)) as { doc?: unknown; focus?: { trackId?: string | null } } | null;
    const doc = normalizeProject(body?.doc);
    if (doc && idle()) setSong({ doc, focus: body?.focus?.trackId ?? null });
  }, [id]);

  const loadModel = useCallback(async () => {
    if (!idle()) return;
    const body = (await fetch(`/api/cad/${id}/doc`).then((r) => (r.ok ? r.json() : null)).catch(() => null)) as { doc?: ModelDoc } | null;
    if (body?.doc && Array.isArray(body.doc.bodies) && idle()) { setModel(body.doc); setShown({}); }
  }, [id]);

  // Again whenever the song or the model moves on (the window, the agent, another tab).
  useEffect(() => { if (wantMusic) void loadSong(); }, [wantMusic, loadSong, studio.rev, studio.open]);
  useEffect(() => { if (wantModel) void loadModel(); }, [wantModel, loadModel, cad.rev, cad.open]);

  const flush = useCallback(async () => {
    timer.current = null;
    const sends = [...queue.current];
    queue.current.clear();
    busy.current++;
    try {
      for (const [bind, { value, pick }] of sends) {
        const app = appOf(bind);
        const url = app === "model" ? `/api/cad/${id}/panel` : `/api/studio/${id}/panel`;
        const body = JSON.stringify(app === "model" ? { bind, value, part: pick } : { bind, value, track: pick });
        const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body }).catch(() => null);
        const said = (await res?.json().catch(() => null)) as { error?: string } | null;
        const name = app === "model" ? "Autora 3D" : "Autora Music";
        if (!res?.ok) onProblem(said?.error ? `${name} did not take that: ${said.error}.` : `Could not reach ${name}. Try again.`);
      }
    } finally {
      busy.current--;
      if (idle()) { void loadSong(); void loadModel(); }
    }
  }, [id, loadSong, loadModel, onProblem]);

  /** A control moved: shown now, sent once the drag settles a little (the latest value of each control wins). */
  const write = useCallback((bind: string, value: Value, pick: unknown) => {
    if (isMusicBind(bind)) {
      setSong((s) => {
        if (!s) return s;
        const doc = structuredClone(s.doc);
        return "error" in writeMusic(doc, bind, value, pick, s.focus) ? s : { ...s, doc };
      });
    } else setShown((s) => ({ ...s, [bind]: value }));
    queue.current.set(bind, { value, pick });
    if (!timer.current) timer.current = setTimeout(() => void flush(), 120);
  }, [flush]);

  useEffect(() => () => { if (timer.current) { clearTimeout(timer.current); void flush(); } }, [flush]);

  /** The value a control shows: off the app for an app value, else undefined (the caller reads the canvas). */
  const read = useCallback((bind: string, picked: unknown): Value | undefined => {
    if (isMusicBind(bind)) return song ? readMusic(song.doc, bind, picked, song.focus) : undefined;
    if (isModelBind(bind)) return bind in shown ? shown[bind] : model ? readModel(model, bind, picked) : undefined;
    return undefined;
  }, [song, model, shown]);

  const options = useCallback((source: string) => (source === "tracks" && song ? musicOptions(song.doc) : source === "parts" && model ? modelOptions(model) : []), [song, model]);

  return useMemo(() => ({ read, write, options }), [read, write, options]);
}
