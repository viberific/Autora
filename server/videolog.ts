/**
 * What differs between two timelines, as a colleague would say it, and when two timelines are the same: for the Video
 * window's command log (server/opencut.ts). The editor owns the project; the server only ever sees the timeline the
 * editor reports after each step, so the log is built from those. Pure, so `tests/videolog.test.ts` runs it alone.
 */

export interface LogClip {
  id: string; type: string; name: string; start: number; duration: number; trimStart: number; trimEnd: number;
  text?: string; speed?: number; hidden?: boolean; muted?: boolean;
  effects?: Array<{ id: string; type: string; enabled: boolean }>; mask?: { id: string; type: string } | null;
  keyframes?: Array<{ property: string; keys: Array<{ id: string; at: number }> }>;
}
export interface LogSnap {
  project: { id: string; name: string };
  canvas: { width: number; height: number };
  fps: unknown;
  tracks: Array<{ id: string; type: string; name: string; clips: LogClip[] }>;
}

const MAX_LINES = 6;
const sec = (n: number) => `${(Math.round(n * 100) / 100).toFixed(2)}s`;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const label = (c: LogClip) => (c.type === "text" ? `title "${(c.text || c.name).slice(0, 30)}"` : `${c.type} clip "${c.name.slice(0, 30)}"`);

/** The timeline as a string two timelines share when they look the same: the playhead and whether it plays are not the project. */
export function fingerprint(s: LogSnap): string {
  return JSON.stringify({ n: s.project.name, c: s.canvas, f: s.fps, t: s.tracks });
}

/** The changes between two timelines, one short line each (at most six; the rest are counted). */
export function describeVideoChange(before: LogSnap, after: LogSnap): string[] {
  const lines: string[] = [];
  if (before.project.name !== after.project.name) lines.push(`renamed the project to "${after.project.name}"`);
  if (before.canvas.width !== after.canvas.width || before.canvas.height !== after.canvas.height) lines.push(`changed the canvas to ${after.canvas.width}x${after.canvas.height}`);
  if (JSON.stringify(before.fps) !== JSON.stringify(after.fps)) lines.push("changed the frame rate");

  const trackWas = new Map(before.tracks.map((t) => [t.id, t]));
  const trackNow = new Map(after.tracks.map((t) => [t.id, t]));
  for (const t of after.tracks) if (!trackWas.has(t.id)) lines.push(`added the ${t.type} track ${t.name}`);
  for (const t of before.tracks) if (!trackNow.has(t.id)) lines.push(`removed the ${t.type} track ${t.name}`);

  const where = new Map<string, string>();
  const was = new Map<string, LogClip>();
  const now = new Map<string, LogClip>();
  for (const t of before.tracks) for (const c of t.clips) { was.set(c.id, c); where.set(`b${c.id}`, t.id); }
  for (const t of after.tracks) for (const c of t.clips) { now.set(c.id, c); where.set(`a${c.id}`, t.id); }

  const added = [...now.values()].filter((c) => !was.has(c.id));
  const removed = [...was.values()].filter((c) => !now.has(c.id));
  for (const c of added.slice(0, 3)) lines.push(`added ${label(c)} at ${sec(c.start)}`);
  if (added.length > 3) lines.push(`added ${plural(added.length - 3, "more clip")}`);
  for (const c of removed.slice(0, 3)) lines.push(`removed ${label(c)}`);
  if (removed.length > 3) lines.push(`removed ${plural(removed.length - 3, "more clip")}`);

  for (const c of now.values()) {
    const w = was.get(c.id);
    if (!w) continue;
    const said: string[] = [];
    if (where.get(`b${c.id}`) !== where.get(`a${c.id}`)) said.push("moved to another track");
    if (w.start !== c.start) said.push(`moved from ${sec(w.start)} to ${sec(c.start)}`);
    if (w.duration !== c.duration || w.trimStart !== c.trimStart || w.trimEnd !== c.trimEnd) said.push(`trimmed (now ${sec(c.duration)} long)`);
    if (w.name !== c.name) said.push(`renamed to "${c.name}"`);
    if ((w.text ?? "") !== (c.text ?? "")) said.push("changed its words");
    if ((w.speed ?? 1) !== (c.speed ?? 1)) said.push(`set the speed to ${c.speed ?? 1}x`);
    if (!!w.hidden !== !!c.hidden) said.push(c.hidden ? "hid it" : "showed it");
    if (!!w.muted !== !!c.muted) said.push(c.muted ? "muted it" : "unmuted it");
    if (JSON.stringify(w.effects ?? []) !== JSON.stringify(c.effects ?? [])) said.push("changed its effects");
    if (JSON.stringify(w.mask ?? null) !== JSON.stringify(c.mask ?? null)) said.push("changed its mask");
    if (JSON.stringify(w.keyframes ?? []) !== JSON.stringify(c.keyframes ?? [])) said.push("changed its keyframes");
    if (said.length) lines.push(`${label(c)}: ${said.join(", ")}`);
  }
  if (lines.length > MAX_LINES) return [...lines.slice(0, MAX_LINES), `and ${lines.length - MAX_LINES} more`];
  return lines;
}
