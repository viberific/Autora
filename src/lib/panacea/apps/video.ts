/**
 * The Video panels' adapter (docs/PANACEA-GAPS.md, G1): what a `video.*` control shows is read off the project open in
 * Autora Video (OpenCut's editor), and moving it runs the editor's own commands (`retime`, `set_params`, `settings`)
 * on the clip picked in the panel. Nothing about the project is kept on the canvas: the project is the one source. The
 * one value kept on the canvas is `video.clip`, which clip a clip's controls act on.
 *
 * The editor has no colour grade, transitions, stabilisation, captions engine, ducking, fades or looks, so there are no
 * panels for them. Export, Markers and Scenes hold the person's own choices and words for the agent to act on.
 *
 * Pure: shared by the server (which runs the commands) and the page (which shows the project).
 */
import type { Value } from "../atoms";

export const VIDEO_CLIP = "video.clip";

const VIDEO_BINDS = [
  VIDEO_CLIP, "video.speed", "video.vol", "video.mute", "video.zoom", "video.opacity", "video.title", "video.titlecolor",
  "video.aspect", "video.fps",
] as const;

/** Every `video.*` value something acts on: the adapter's, and what Export, Markers and Scenes hold for the agent. */
export const VIDEO_WIRED: readonly string[] = [...VIDEO_BINDS, "video.fmt", "video.res", "video.markers", "video.scenes"];

const ASPECTS: Record<string, { width: number; height: number }> = {
  "16:9": { width: 1920, height: 1080 }, "9:16": { width: 1080, height: 1920 }, "1:1": { width: 1080, height: 1080 }, "4:5": { width: 1080, height: 1350 },
};

export const isVideoBind = (bind: string): boolean => (VIDEO_BINDS as readonly string[]).includes(bind);

/** What the editor's `state` says, as far as these panels read it. */
interface VideoClip {
  id: string;
  type: string;
  name: string;
  speed?: number;
  muted?: boolean;
  text?: string;
  params?: Record<string, unknown>;
}
export interface VideoState {
  canvas: { width: number; height: number };
  fps: unknown;
  tracks: Array<{ clips: VideoClip[] }>;
}

/** What is run in the editor: its command's name (`set_params`, `retime`, `settings`) and arguments. */
interface VideoCommand { name: string; args: Record<string, unknown> }

const round2 = (n: number) => Math.round(n * 100) / 100;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const num = (v: Value): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

const clipsOf = (s: VideoState): VideoClip[] => s.tracks.flatMap((t) => t.clips);

/** The clips a person can pick, in the order of the timeline's tracks. */
export function videoOptions(s: VideoState): Array<{ value: string; label: string }> {
  return clipsOf(s).map((c) => ({ value: c.id, label: `${c.type === "text" ? c.text || c.name : c.name} (${c.type})` }));
}

/** What a control needs of a clip, and what to say when it is not that. */
const NEEDS: Record<string, { fits: (c: VideoClip) => boolean; what: string; prefer?: (c: VideoClip) => boolean }> = {
  "video.speed": { fits: (c) => c.type === "video" || c.type === "audio", what: "speed" },
  "video.vol": { fits: (c) => c.type === "video" || c.type === "audio", what: "volume" },
  "video.mute": { fits: (c) => c.type === "video" || c.type === "audio", what: "sound" },
  // A title can be scaled and faded too, but with nothing picked it is the film's picture that is meant.
  "video.zoom": { fits: (c) => c.type !== "audio", what: "picture", prefer: (c) => c.type === "video" || c.type === "image" },
  "video.opacity": { fits: (c) => c.type !== "audio", what: "picture", prefer: (c) => c.type === "video" || c.type === "image" },
  "video.title": { fits: (c) => c.type === "text", what: "words" },
  "video.titlecolor": { fits: (c) => c.type === "text", what: "words" },
};

/** The clip a control acts on: the one picked if it fits, else (nothing picked or it is gone) the first that does. */
function clipFor(s: VideoState, bind: string, picked: unknown): { clip: VideoClip } | { error: string } {
  const need = NEEDS[bind]!;
  const all = clipsOf(s);
  const named = all.find((c) => c.id === picked);
  if (named) return need.fits(named) ? { clip: named } : { error: `"${named.name}" is ${named.type === "text" ? "a title" : `a ${named.type}`} and has no ${need.what}: pick another clip in the Clip list` };
  const first = (need.prefer && all.find((c) => need.fits(c) && need.prefer!(c))) || all.find(need.fits);
  return first ? { clip: first } : { error: `the project has no clip with ${need.what} yet` };
}

const fpsOf = (fps: unknown): number | undefined => {
  if (typeof fps === "number") return fps;
  const f = fps as { numerator?: number; denominator?: number } | null;
  return f?.numerator && f.denominator ? round2(f.numerator / f.denominator) : undefined;
};

function aspectOf(c: { width: number; height: number }): string {
  const r = c.width / c.height;
  return Object.entries(ASPECTS).find(([, a]) => Math.abs(a.width / a.height - r) < 0.01)?.[0] ?? "custom";
}

/** What a control shows, read off the project; undefined when it has nothing for it (no clip it fits yet). */
export function readVideo(s: VideoState, bind: string, picked?: unknown): Value | undefined {
  if (bind === VIDEO_CLIP) return clipsOf(s).find((c) => c.id === picked)?.id ?? clipsOf(s)[0]?.id ?? "";
  if (bind === "video.aspect") return aspectOf(s.canvas);
  if (bind === "video.fps") return fpsOf(s.fps);
  if (!NEEDS[bind]) return undefined;
  const got = clipFor(s, bind, picked);
  if ("error" in got) return undefined;
  const c = got.clip;
  const p = c.params ?? {};
  switch (bind) {
    case "video.speed": return c.speed ?? 1;
    case "video.vol": return typeof p.volume === "number" ? round2(p.volume) : 0;
    case "video.mute": return c.muted === true;
    case "video.zoom": return typeof p["transform.scaleX"] === "number" ? round2(p["transform.scaleX"]) : 1;
    case "video.opacity": return typeof p.opacity === "number" ? Math.round(p.opacity * 100) : 100;
    case "video.title": return c.text ?? "";
    case "video.titlecolor": return typeof p.color === "string" ? p.color : "#ffffff";
  }
  return undefined;
}

/**
 * The editor's own commands that make a control's value true, on the clip it acts on; or why it cannot be. `did` says
 * it in a person's words. `video.clip` is not the project's and is not handled here.
 */
export function videoCommands(s: VideoState, bind: string, v: Value, picked?: unknown): { did: string; commands: VideoCommand[] } | { error: string } {
  if (bind === "video.aspect") {
    const a = ASPECTS[String(v)];
    return a ? { did: `canvas ${String(v)} (${a.width}x${a.height})`, commands: [{ name: "settings", args: { width: a.width, height: a.height } }] } : { error: `the aspect is one of ${Object.keys(ASPECTS).join(", ")}` };
  }
  if (bind === "video.fps") {
    const n = num(v);
    return n === null || n < 1 ? { error: "the frame rate is a number" } : { did: `${Math.round(clamp(n, 12, 60))} fps`, commands: [{ name: "settings", args: { fps: Math.round(clamp(n, 12, 60)) } }] };
  }
  if (!NEEDS[bind]) return { error: `nothing in the project answers to ${bind}` };
  const got = clipFor(s, bind, picked);
  if ("error" in got) return got;
  const c = got.clip;
  const set = (params: Record<string, unknown>, did: string) => ({ did: `${c.name}: ${did}`, commands: [{ name: "set_params", args: { elementId: c.id, params } }] });
  switch (bind) {
    case "video.speed": {
      const n = num(v);
      if (n === null || n <= 0) return { error: "the speed is a number above zero" };
      const rate = round2(clamp(n, 0.25, 4));
      return { did: `${c.name}: speed ${rate}×`, commands: [{ name: "retime", args: { elementId: c.id, rate, maintainPitch: true } }] };
    }
    case "video.vol": { const n = num(v); return n === null ? { error: "the volume is in decibels" } : set({ volume: clamp(n, -60, 20) }, `volume ${clamp(n, -60, 20)} dB`); }
    case "video.mute": return set({ muted: v === true }, v === true ? "muted" : "unmuted");
    case "video.zoom": { const n = num(v); return n === null || n <= 0 ? { error: "the zoom is a number above zero" } : set({ "transform.scaleX": clamp(n, 0.1, 5), "transform.scaleY": clamp(n, 0.1, 5) }, `zoom ${round2(clamp(n, 0.1, 5))}×`); }
    case "video.opacity": { const n = num(v); return n === null ? { error: "the opacity is a percentage" } : set({ opacity: clamp(n, 0, 100) / 100 }, `opacity ${clamp(n, 0, 100)}%`); }
    case "video.title": return typeof v === "string" && v.trim() ? set({ content: v }, "words changed") : { error: "a title needs some words" };
    case "video.titlecolor": return typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v) ? set({ color: v }, `colour ${v}`) : { error: 'the colour is a hex colour such as "#ffffff"' };
  }
  return { error: `nothing in the project answers to ${bind}` };
}
