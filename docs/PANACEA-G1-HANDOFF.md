# Panacea G1: handoff (start here)

Where G1 of `docs/PANACEA-GAPS.md` stands, and exactly how to finish it. G0 is done; G1 is next. Written so a fresh
session can pick it up without the conversation that produced it.

## Status of the whole plan (2026-11-02)

| Step | Status | What remains |
|---|---|---|
| G0 Make it honest | **Done** (0.9.321, 0.9.322) | — |
| G1 Engine panels drive the engines | **Started: Music designed, not wired** | Music server route + panels + manual + tests; then 3D, Video, Game |
| G2 Windows the agent can lay out | Not started | see the plan |
| G7 Verified where it runs | Not started | needs CI or the Docker image |
| G3 Full native surfaces (full spreadsheet first) | Not started | see the plan |
| G5 Projects finished | Not started | see the plan |
| G4 Visible work, complete | Not started | Games first |
| G6 Whole apps and sites (N2–N8) | Not started | `docs/PANACEA-NEXT.md` |

The order and the "done when" of every step are in `docs/PANACEA-GAPS.md`, "The plan". Decisions the person made:

- Panels whose controls change nothing are **hidden** until wired (G0 did this: `src/lib/panacea/wiring.ts`).
- The native table becomes a **full spreadsheet**, with the same design: a control is there when it is needed, gone when
  not, and offered before it is asked for.
- **Everything** in the plan is to be done, polished, with nothing broken.

## How G0 left things

- `src/lib/panacea/wiring.ts`: a bind named for an app (`music.`, `video.`, `model.`, `game.`, `ui.`, `doc.`) is live
  only when listed in `WIRED`. `treeLive(tree)` filters the picker (`PanaceaWindow`), the rules (`rules.ts`, `LIVE`) and
  the agent (`allRecipes()` and `panacea_place` in `server/panacea.ts`). A panel already on a canvas that is not live
  shows a note and an inert body (`PanelCard.tsx`); `describeCanvas` flags it.
- So wiring an app = an adapter that acts on its binds, then adding them to `WIRED`. `tests/panacea.test.ts` already
  fails if an offered recipe has an unwired bind.

## Music: the design

**The song is the one source.** A `music.*` control reads the song in Autora Music and writes to it; nothing about the
song is copied onto the canvas, so the panel, the Music window and the agent cannot disagree. The one value kept on the
canvas is `music.track`: which track a track's controls (channel, EQ, instrument, reverb) act on. If it names no track,
the clip open in the Music window (`focus.trackId` from `GET /api/studio/:s/doc`) is used, else the first track.

Value mapping (panel ↔ song, `src/lib/studio/model.ts`):

| Bind | Song | Panel range |
|---|---|---|
| `music.bpm` | `bpm` | 30–300 |
| `music.sig` | `beatsPerBar` (2/4 3/4 4/4 5/4 6/8 7/8) | segmented |
| `music.loop` | `loop` | toggle |
| `music.root` / `music.scale` | `key.root` / `key.scale` (all 10 `SCALE_NAMES`) | select |
| `music.master` | `master` ×100 | 0–100 |
| `music.vol` / `music.pan` | track `volume` ×100 / `pan` ×50 | 0–100 / −50–50 |
| `music.mute` / `music.solo` | track | toggle |
| `music.reverb` | track `reverb` ×100 | 0–100 |
| `music.low/mid/high` | track `eq` dB (±15, half-dB steps) | ±12 |
| `music.inst` | track `instrument` (7 `INSTRUMENTS`; refuses kit↔tuned on a track with notes, as `studio_track` does) | swatches |
| `music.steps` | the first drum track's notes in beats 0–4: rows Kick 36, Snare 38, Hat 42, Clap 39 × 16 sixteenths; makes a Drums track and a Beat clip if none | pads 16×4 |

**Writing.** Server-side, one function used by both the person (page) and the agent:

1. `server/studio.ts`: export `studioPanel(session, bind, value, track, who)`. Clone `e.project`, `writeMusic(...)`,
   refuse on `{error}`, `setOpen(session, true)` (the Music window appears: the person sees the effect), then
   `commit(session, e, next, "agent")`. For the person's own change also set `e.quiet = e.rev` after the commit, so the
   window loads it without lighting it up. `commit` as "agent" is what makes the open window reload
   (`src/components/studio/useSong.ts` only reloads on `by === "agent"`).
2. Route `POST /api/studio/:session/panel {bind, value, track}` in `studioRoutes`, refusing when Music is switched off
   (`opts.off()`), like the other routes. No side effects on GET.
3. `src/App.tsx` (about line 1709): `revision: studio.by === "agent" && studio.quiet !== studio.rev ? studio.rev :
   undefined`, so a person's slider does not make Follow jump the camera.
4. `server/panacea.ts`: in `panacea_set` and in `panacea_place`'s opening values, a key where
   `isMusicBind(k) && k !== MUSIC_TRACK` goes to `studioPanel(..., "agent")` instead of `setValue`. With Visible work
   on, the panel is moved by hand (the existing `set` step) and the page sends it; apply again after the hand returns
   (idempotent).
5. `describeCanvas` (`src/lib/panacea/canvas.ts`) should show `music.*` values read off the song: give it an optional
   `appValue(bind)` resolver; the server passes one built from `studioSong(session)`.

**Reading, on the page.** `useAppValues` (below) fetches `GET /api/studio/:s/doc` when a panel on the canvas binds a
`music.*` value, and again whenever `useStudioState().rev` moves. `api.value(key)` returns `apps.read(key, track) ??
valueAt(canvas, key)`; `api.options("tracks")` lists the song's tracks; `api.set` sends app values to `apps.write` and
only marks the panel `touched` on the canvas (with `quietly`). A write shows at once (optimistic) and is sent 120 ms
later, the latest value per control winning, then the song is fetched again.

**The Music recipes** (`src/lib/panacea/library.ts`, `MUSIC`): each wired or removed, never kept as decoration.

- Keep, wired: transport (drop Click: there is no metronome), key (all 10 scales), channel (+ a Track select
  `sel(MUSIC_TRACK, "Track", "tracks")`), drums, time (signatures above), eq (+ Track), instrument (+ Track, all 7
  instruments), master (drop the level meter: nothing reports output level).
- Reshape: effects → "Reverb" (Track + reverb; there is no delay or drive), export → only the ask button (WAV only).
- Turn into the person's own content (plain binds, which are live): chords (`chords`, `chordstyle`, plus an ask "Play
  these" that has the agent use `studio_make`), structure (`sections`). The person writes chords and sections; the
  agent places them. That keeps the creative choice theirs.
- Delete: arrange, envelope, filter, compressor, groove, pad (xy), arp. Nothing in the engine can honour them.
- `coach` has no app binds and stays.

Then add `"music."` to `WIRED`, update the Music manual in `server/handbook.ts` (panels drive the song; a Track
select picks the track) and `tests/handbook.test.ts`, and add tests: a pure test of `readMusic`/`writeMusic` (round
trips, the drum grid, refusals) in `tests/panacea.test.ts` or a new `tests/panacea-music.test.ts`; a route test (a
panel write changes `GET /api/studio/:s/doc`, opens the window, refuses when switched off); a browser test that moves
the Tempo stepper and sees the Music window's tempo change, and the reverse. Release: bump the version, rewrite
`releaseNotes`.

## Music: the code already written

Not in the build (it would be unused code until the route exists). Put it back as these files.

### `src/lib/panacea/apps/music.ts`

```ts
/**
 * The Music panels' adapter (docs/PANACEA-GAPS.md, G1): what a `music.*` control shows is read off the song in Autora
 * Music, and moving it changes that song. Nothing about the song is kept on the canvas: the song is the one source, so
 * the panel, the Music window and the agent always agree.
 *
 * A track's controls (channel, EQ, instrument) act on one track: the one picked in the panel's Track list
 * (`music.track`, the one value kept on the canvas), else the clip open in the Music window, else the first track.
 *
 * Pure: shared by the server (which applies a change) and the page (which shows the song).
 */
import type { Value } from "../atoms";
import {
  INSTRUMENTS, MAX_BPM, MIN_BPM, NOTE_NAMES, SCALE_NAMES, clamp, newClip, newTrack, tidy, uid,
  type InstrumentId, type Project, type ScaleName, type Track,
} from "../../studio/model";

/** The track a track's controls act on: kept on the canvas, not in the song. */
export const MUSIC_TRACK = "music.track";

/** Every value the adapter acts on. */
export const MUSIC_BINDS = [
  MUSIC_TRACK, "music.bpm", "music.sig", "music.loop", "music.root", "music.scale", "music.master",
  "music.vol", "music.pan", "music.mute", "music.solo", "music.reverb", "music.low", "music.mid", "music.high",
  "music.inst", "music.steps",
] as const;

const SONG = new Set(["music.bpm", "music.sig", "music.loop", "music.root", "music.scale", "music.master"]);

/** The drum pattern panel's rows, top to bottom, and the drum each plays. */
export const PATTERN_ROWS: ReadonlyArray<{ name: string; pitch: number }> = [
  { name: "Kick", pitch: 36 }, { name: "Snare", pitch: 38 }, { name: "Hat", pitch: 42 }, { name: "Clap", pitch: 39 },
];
/** Sixteen steps of a sixteenth note each: the first four beats of the song. */
export const PATTERN_STEPS = 16;
const STEP = 0.25;

export const SIGNATURES: Record<string, number> = { "2/4": 2, "3/4": 3, "4/4": 4, "5/4": 5, "6/8": 6, "7/8": 7 };

export function isMusicBind(bind: string): boolean {
  return (MUSIC_BINDS as readonly string[]).includes(bind);
}

/** The track a track's control acts on (see the top of this file). */
export function musicTrack(p: Project, picked: unknown, focus?: string | null): Track | null {
  return p.tracks.find((t) => t.id === picked) ?? p.tracks.find((t) => t.id === focus) ?? p.tracks[0] ?? null;
}

/** The drum track the pattern plays on: the picked track if it is drums, else the first drum track. */
function drumTrack(p: Project, picked: unknown, focus?: string | null): Track | null {
  const t = musicTrack(p, picked, focus);
  return t?.instrument === "kit" ? t : p.tracks.find((x) => x.instrument === "kit") ?? null;
}

const pct = (v: number) => Math.round(v * 100);

/** What a control shows, read off the song; undefined when the song has nothing for it (no track yet). */
export function readMusic(p: Project, bind: string, picked?: unknown, focus?: string | null): Value | undefined {
  switch (bind) {
    case MUSIC_TRACK: return musicTrack(p, picked, focus)?.id ?? "";
    case "music.bpm": return p.bpm;
    case "music.sig": return Object.entries(SIGNATURES).find(([, n]) => n === p.beatsPerBar)?.[0] ?? `${p.beatsPerBar}/4`;
    case "music.loop": return p.loop;
    case "music.root": return NOTE_NAMES[p.key.root];
    case "music.scale": return p.key.scale;
    case "music.master": return clamp(pct(p.master), 0, 120);
    case "music.steps": {
      const t = drumTrack(p, picked, focus);
      const out = Array.from({ length: PATTERN_ROWS.length * PATTERN_STEPS }, () => 0);
      if (!t) return out;
      for (const c of t.clips) for (const n of c.notes) {
        const at = c.start + n.start;
        const col = Math.round(at / STEP);
        const row = PATTERN_ROWS.findIndex((r) => r.pitch === n.pitch);
        if (row < 0 || col < 0 || col >= PATTERN_STEPS || Math.abs(at - col * STEP) > 0.05) continue;
        out[row * PATTERN_STEPS + col] = 1;
      }
      return out;
    }
  }
  const t = musicTrack(p, picked, focus);
  if (!t) return undefined;
  switch (bind) {
    case "music.vol": return clamp(pct(t.volume), 0, 120);
    case "music.pan": return Math.round(t.pan * 50);
    case "music.mute": return t.mute;
    case "music.solo": return t.solo;
    case "music.reverb": return pct(t.reverb);
    case "music.low": return t.eq.low;
    case "music.mid": return t.eq.mid;
    case "music.high": return t.eq.high;
    case "music.inst": return t.instrument;
  }
  return undefined;
}

/** The choices a control offers that come from the song: its tracks. */
export function musicOptions(p: Project): Array<{ value: string; label: string; color?: string }> {
  return p.tracks.map((t) => ({ value: t.id, label: t.name, color: t.color }));
}

const num = (v: Value): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * Moves the song to what a control was set to, in place. Returns what was done, in a person's words, or an error.
 * `music.track` is not the song's and is not handled here.
 */
export function writeMusic(p: Project, bind: string, v: Value, picked?: unknown, focus?: string | null): { did: string } | { error: string } {
  if (SONG.has(bind)) {
    switch (bind) {
      case "music.bpm": { const n = num(v); if (n === null) return { error: "the tempo is a number" }; p.bpm = clamp(Math.round(n * 100) / 100, MIN_BPM, MAX_BPM); return { did: `tempo ${p.bpm} bpm` }; }
      case "music.sig": { const n = SIGNATURES[String(v)]; if (!n) return { error: `the time is one of ${Object.keys(SIGNATURES).join(", ")}` }; p.beatsPerBar = n; return { did: `time ${String(v)}` }; }
      case "music.loop": p.loop = v === true; return { did: v === true ? "looping on" : "looping off" };
      case "music.root": { const i = NOTE_NAMES.indexOf(String(v) as (typeof NOTE_NAMES)[number]); if (i < 0) return { error: "the root is a note name, C to B" }; p.key = { ...p.key, root: i }; return { did: `key ${NOTE_NAMES[i]} ${p.key.scale}` }; }
      case "music.scale": { if (!SCALE_NAMES.includes(String(v) as ScaleName)) return { error: `the scale is one of ${SCALE_NAMES.join(", ")}` }; p.key = { ...p.key, scale: String(v) as ScaleName }; return { did: `key ${NOTE_NAMES[p.key.root]} ${p.key.scale}` }; }
      case "music.master": { const n = num(v); if (n === null) return { error: "the master is a number" }; p.master = clamp(n / 100, 0, 1.2); return { did: `master ${pct(p.master)}%` }; }
    }
  }
  if (bind === "music.steps") {
    if (!Array.isArray(v)) return { error: "the pattern is a list of steps" };
    let t = drumTrack(p, picked, focus);
    if (!t) { t = newTrack(p, "kit", "Drums"); p.tracks.push(t); }
    const len = Math.max(PATTERN_STEPS * STEP, p.beatsPerBar);
    let clip = t.clips.find((c) => c.start <= 0 && c.start + c.length > 0);
    if (!clip) { clip = newClip(0, len, "Beat"); t.clips.push(clip); t.clips.sort((a, b) => a.start - b.start); }
    const on = readMusic(p, "music.steps", t.id) as number[];
    let added = 0, removed = 0;
    for (let row = 0; row < PATTERN_ROWS.length; row++) {
      for (let col = 0; col < PATTERN_STEPS; col++) {
        const want = (v as number[])[row * PATTERN_STEPS + col] === 1;
        if (want === (on[row * PATTERN_STEPS + col] === 1)) continue;
        const pitch = PATTERN_ROWS[row]!.pitch;
        const at = col * STEP;
        if (want) {
          // The clip covering this step (a beat longer than the first clip goes in it as it grows).
          const c = t.clips.find((x) => x.start <= at && x.start + x.length > at) ?? clip;
          if (at - c.start >= c.length) c.length = tidy(at - c.start + STEP);
          c.notes.push({ id: uid("n"), pitch, start: tidy(at - c.start), length: STEP, vel: row === 2 ? 0.7 : 0.9 });
          c.notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
          added++;
        } else {
          for (const c of t.clips) {
            const before = c.notes.length;
            c.notes = c.notes.filter((n) => !(n.pitch === pitch && Math.abs(c.start + n.start - at) <= 0.05));
            removed += before - c.notes.length;
          }
        }
      }
    }
    return { did: `drum pattern on ${t.name}: ${added} step${added === 1 ? "" : "s"} on, ${removed} off` };
  }
  const t = musicTrack(p, picked, focus);
  if (!t) return { error: "the song has no tracks yet" };
  switch (bind) {
    case "music.vol": { const n = num(v); if (n === null) return { error: "the volume is a number" }; t.volume = clamp(n / 100, 0, 1.2); return { did: `${t.name} volume ${pct(t.volume)}` }; }
    case "music.pan": { const n = num(v); if (n === null) return { error: "the pan is a number" }; t.pan = clamp(n / 50, -1, 1); return { did: `${t.name} pan ${Math.round(t.pan * 50)}` }; }
    case "music.mute": t.mute = v === true; return { did: `${t.name} ${t.mute ? "muted" : "unmuted"}` };
    case "music.solo": t.solo = v === true; return { did: `${t.name} solo ${t.solo ? "on" : "off"}` };
    case "music.reverb": { const n = num(v); if (n === null) return { error: "the reverb is a number" }; t.reverb = clamp(n / 100, 0, 1); return { did: `${t.name} reverb ${pct(t.reverb)}` }; }
    case "music.low": case "music.mid": case "music.high": {
      const n = num(v); if (n === null) return { error: "the EQ is in decibels" };
      const band = bind.slice(6) as "low" | "mid" | "high";
      t.eq = { ...t.eq, [band]: clamp(Math.round(n * 2) / 2, -15, 15) };
      return { did: `${t.name} ${band} ${t.eq[band]} dB` };
    }
    case "music.inst": {
      const id = String(v) as InstrumentId;
      if (!INSTRUMENTS.some((i) => i.id === id)) return { error: `the instrument is one of ${INSTRUMENTS.map((i) => i.id).join(", ")}` };
      if ((id === "kit") !== (t.instrument === "kit") && t.clips.some((c) => c.notes.length)) {
        return { error: `${t.name} has notes, and drums and tuned instruments do not share them: add a new track for ${id === "kit" ? "drums" : "it"}` };
      }
      t.instrument = id;
      return { did: `${t.name} plays ${INSTRUMENTS.find((i) => i.id === id)!.name}` };
    }
  }
  return { error: `nothing in the song answers to ${bind}` };
}
```

### `src/components/panacea/useAppValues.ts`

```ts
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
```

### The page wiring (a diff against `src/components/PanaceaWindow.tsx`, `context.ts`, `Atoms.tsx`)

```diff
diff --git a/src/components/PanaceaWindow.tsx b/src/components/PanaceaWindow.tsx
index 68df76e..04e9fba 100644
--- a/src/components/PanaceaWindow.tsx
+++ b/src/components/PanaceaWindow.tsx
@@ -25,6 +25,8 @@ import { autoSettings, renderFull } from "./panacea/imagegl";
 import type { PanelActions } from "./panacea/PanelCard";
 import { pictureOf } from "./panacea/Surfaces";
 import { useCanvas } from "./panacea/useCanvas";
+import { isAppBind, useAppValues, wantsMusic } from "./panacea/useAppValues";
+import { MUSIC_TRACK } from "../lib/panacea/apps/music";
 import { SaveButton, keptAs } from "./SaveButton";
 import { LoadButton, type LoadResult } from "./LoadButton";
 import { PANACEA_LOADED, offerKeep } from "../lib/panaceaBridge";
@@ -87,6 +89,9 @@ export function PanaceaWindow({ sessionId, hosted = [], nativeOpen = true, scene
   /** Recipes waved away lately, and when: not offered again for a while, whatever the profile says. */
   const waved = useRef(new Map<string, number>());
   const focusedKind = canvas.surfaces.find((surface) => surface.id === canvas.focus)?.kind;
+  // The apps a panel drives (the song, for a Music panel): read off the app and changed there, not kept on the canvas.
+  const musicWanted = useMemo(() => wantsMusic(canvas.panels.map((p) => p.tree)), [canvas.panels]);
+  const apps = useAppValues(sessionId, musicWanted, setProblem);
 
   // Learning may reveal controls or change density, but never midway through typing or dragging.
   useEffect(() => {
@@ -154,7 +159,11 @@ export function PanaceaWindow({ sessionId, hosted = [], nativeOpen = true, scene
     if (bad) { setProblem(`That value does not fit: ${bad}.`); return; }
     const first = !panel.touched && !touched.current.has(panel.id);
     touched.current.add(panel.id);
-    edit((d) => {
+    if (isAppBind(key)) {
+      // An app's value: the app changes (useAppValues); the canvas only notes that the panel was used.
+      apps.write(key, v, live.current.values[MUSIC_TRACK]);
+      quietly((d) => { const p = d.panels.find((x) => x.id === panel.id); if (p) p.touched = Date.now(); });
+    } else edit((d) => {
       setValue(d, key, v);
       const p = d.panels.find((x) => x.id === panel.id);
       if (p) p.touched = Date.now();
@@ -177,9 +186,10 @@ export function PanaceaWindow({ sessionId, hosted = [], nativeOpen = true, scene
       timers.delete(key);
       const { surface } = parseBind(key);
       const where = surface ? live.current.surfaces.find((s) => s.id === surface)?.title : null;
-      void tell(`set ${label.replace(/ .*$/, "") || key} to ${show(valueAt(live.current, key))}${where ? ` on ${where}` : ""} (panel "${panel.title}")`, { bind: key, value: valueAt(live.current, key) });
+      const now = isAppBind(key) ? v : valueAt(live.current, key);
+      void tell(`set ${label.replace(/ .*$/, "") || key} to ${show(now)}${where ? ` on ${where}` : ""} (panel "${panel.title}")`, { bind: key, value: now });
     }, 650));
-  }, [base, edit, live, quietly, tell]);
+  }, [apps, base, edit, live, quietly, tell]);
 
   const act = useCallback((bind: string) => {
     const { surface, param } = parseBind(bind);
@@ -313,8 +323,9 @@ export function PanaceaWindow({ sessionId, hosted = [], nativeOpen = true, scene
   const hold = doc.hold;
   const api: PanaceaApi = useMemo(() => ({
     canvas, profile: displayProfile, sessionId, set, act, ask, hold, expand, writeDoc, writeBoard, setMode,
-    value: (key: string) => valueAt(canvas, key),
-  }), [canvas, displayProfile, sessionId, set, act, ask, hold, expand, writeDoc, writeBoard, setMode]);
+    value: (key: string) => apps.read(key, canvas.values[MUSIC_TRACK]) ?? valueAt(canvas, key),
+    options: apps.options,
+  }), [apps, canvas, displayProfile, sessionId, set, act, ask, hold, expand, writeDoc, writeBoard, setMode]);
 
   // ------------------------------------------------------- panel actions --
 
diff --git a/src/components/panacea/Atoms.tsx b/src/components/panacea/Atoms.tsx
index 00cce58..99826f8 100644
--- a/src/components/panacea/Atoms.tsx
+++ b/src/components/panacea/Atoms.tsx
@@ -33,6 +33,7 @@ function optionsOf(api: PanaceaApi, node: Node, panel: Panel): Option[] {
   const raw = node.props?.options;
   if (Array.isArray(raw)) return raw as Option[];
   const data = api.canvas.surfaces.find((s) => s.kind === "data" && (s.id === panel.context || bindsOf(node).some((b) => parseBind(b).surface === s.id))) ?? api.canvas.surfaces.find((s) => s.kind === "data");
+  if (raw === "tracks") return api.options(raw);
   if (raw === "looks") return Object.entries(LOOKS).map(([value, l]) => ({ value, label: l.label, color: l.swatch }));
   if (raw === "palette") {
     const img = api.canvas.surfaces.find((s) => s.kind === "image" && s.id === panel.context) ?? api.canvas.surfaces.find((s) => s.kind === "image");
diff --git a/src/components/panacea/context.ts b/src/components/panacea/context.ts
index 986d91c..332cd8f 100644
--- a/src/components/panacea/context.ts
+++ b/src/components/panacea/context.ts
@@ -9,8 +9,10 @@ import type { Profile } from "../../lib/panacea/profile";
 export interface PanaceaApi {
   canvas: Canvas;
   profile: Profile;
-  /** The value at a bind, or undefined. */
+  /** The value at a bind, or undefined. An app's value (`music.bpm`) is read off that app (src/lib/panacea/apps/). */
   value: (key: string) => Value | undefined;
+  /** Choices a control offers that come from an app: `tracks` (the song's tracks). */
+  options: (source: string) => Array<{ value: string; label: string; color?: string }>;
   /** The person set a value with a control on `panel`. `label` names the step in the history. */
   set: (key: string, value: Value, panel: Panel, label: string) => void;
   /** A surface's action (reset, auto, export, clear). */
```

## After Music

- **3D** (`caddesk`, `server/cad*.ts`): the same shape. `model.x/y/z`, `rx/ry/rz`, scale, colour, roughness, metalness
  act on the selected part through the cad tools; camera and light through the scene. Reshape or delete what the
  modeller cannot do (`3d.print` has no printer path: delete).
- **Video** (OpenCut commands, `src/components/OpenCutWindow.tsx`): speed, volume, fades, title, aspect, grade, export.
- **Game** (the GDevelop bridge): needs the game editor built to test; movement, physics, health, camera.
- Each engine: wired or deleted, read back from the engine, and set by hand in the engine's own window with Visible
  work on. Each one its own release.

## Things learned in this session that will save time

- Browser tests need `AUTORA_BROWSER_PATH=/opt/pw-browsers/chromium-1243/chrome-linux64/chrome` here; without it they
  print "skip" and look green.
- `npx vite build` empties `dist/`, which drops the 3D modeller: run `npm --prefix autora-3d run build` after it, or the
  `ui-cad-*` tests skip.
- The e2e harness runs `server.ts` from source: do not edit `server/` while a browser suite is running.
- With Visible work on, making a document by hand also places three panels by hand; such a turn takes about 25 s, so a
  test needs `app.turn(..., 90_000)`.
- The agent's briefing budget (`tests/toolbudget.test.ts`, 28,000 chars) grows with each built editor; it is about
  27,000 with the modeller built.
