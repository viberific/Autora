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
const MUSIC_BINDS = [
  MUSIC_TRACK, "music.bpm", "music.sig", "music.loop", "music.root", "music.scale", "music.master",
  "music.vol", "music.pan", "music.mute", "music.solo", "music.reverb", "music.low", "music.mid", "music.high",
  "music.inst", "music.steps",
] as const;

const SONG = new Set(["music.bpm", "music.sig", "music.loop", "music.root", "music.scale", "music.master"]);

/** The drum pattern panel's rows, top to bottom, and the drum each plays. */
const PATTERN_ROWS: ReadonlyArray<{ name: string; pitch: number }> = [
  { name: "Kick", pitch: 36 }, { name: "Snare", pitch: 38 }, { name: "Hat", pitch: 42 }, { name: "Clap", pitch: 39 },
];
/** Sixteen steps of a sixteenth note each: the first four beats of the song. */
const PATTERN_STEPS = 16;
const STEP = 0.25;

const SIGNATURES: Record<string, number> = { "2/4": 2, "3/4": 3, "4/4": 4, "5/4": 5, "6/8": 6, "7/8": 7 };

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
