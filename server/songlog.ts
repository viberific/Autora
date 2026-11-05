/**
 * What differs between two versions of a song, as a colleague would say it: for the Music window's command log, where the
 * person's edits arrive as whole songs (docs/ENGINE-SURVEY.md). Pure, so `tests/studiolog.test.ts` runs it without a server.
 */
import type { Clip, Project, Track } from "../src/lib/studio/model";

const MAX_LINES = 6;

const noteCount = (clips: Clip[]) => clips.reduce((n, c) => n + c.notes.length, 0);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The track's settings that differ, by name ("volume", "mute"...). */
function settings(a: Track, b: Track): string[] {
  const out: string[] = [];
  if (a.name !== b.name) out.push("name");
  if (a.instrument !== b.instrument) out.push(`instrument (now ${b.instrument})`);
  if (a.volume !== b.volume) out.push("volume");
  if (a.pan !== b.pan) out.push("pan");
  if (a.mute !== b.mute) out.push(b.mute ? "muted" : "unmuted");
  if (a.solo !== b.solo) out.push(b.solo ? "soloed" : "unsoloed");
  if (a.reverb !== b.reverb) out.push("reverb");
  if (JSON.stringify(a.eq) !== JSON.stringify(b.eq)) out.push("EQ");
  return out;
}

/** The changes between two songs, one short line each (at most six; the rest are counted). */
export function describeSongChange(before: Project, after: Project): string[] {
  const lines: string[] = [];
  if (before.name !== after.name) lines.push(`renamed the song to "${after.name}"`);
  if (before.bpm !== after.bpm) lines.push(`changed the tempo from ${before.bpm} to ${after.bpm} bpm`);
  if (before.beatsPerBar !== after.beatsPerBar) lines.push(`changed the time signature to ${after.beatsPerBar} beats a bar`);
  if (before.key.root !== after.key.root || before.key.scale !== after.key.scale) lines.push("changed the key");
  if (before.master !== after.master) lines.push("changed the master volume");
  if (before.loop !== after.loop) lines.push(after.loop ? "turned looping on" : "turned looping off");

  const was = new Map(before.tracks.map((t) => [t.id, t]));
  const now = new Map(after.tracks.map((t) => [t.id, t]));
  for (const t of after.tracks) if (!was.has(t.id)) lines.push(`added the track ${t.name}`);
  for (const t of before.tracks) if (!now.has(t.id)) lines.push(`removed the track ${t.name}`);
  for (const t of after.tracks) {
    const old = was.get(t.id);
    if (!old) continue;
    const set = settings(old, t);
    if (set.length) lines.push(`changed ${t.name}: ${set.join(", ")}`);
    const clipWas = new Map(old.clips.map((c) => [c.id, c]));
    const clipNow = new Map(t.clips.map((c) => [c.id, c]));
    const added = t.clips.filter((c) => !clipWas.has(c.id));
    const gone = old.clips.filter((c) => !clipNow.has(c.id));
    if (added.length) lines.push(`added ${plural(added.length, "clip")} to ${t.name} (${plural(noteCount(added), "note")})`);
    if (gone.length) lines.push(`removed ${plural(gone.length, "clip")} from ${t.name}`);
    for (const c of t.clips) {
      const prior = clipWas.get(c.id);
      if (!prior) continue;
      if (JSON.stringify(prior.notes) !== JSON.stringify(c.notes)) lines.push(`changed the notes of ${t.name} "${c.name}" (${plural(prior.notes.length, "note")} to ${c.notes.length})`);
      else if (prior.start !== c.start || prior.length !== c.length || prior.name !== c.name) lines.push(`moved or resized ${t.name} "${c.name}"`);
    }
  }
  if (lines.length > MAX_LINES) return [...lines.slice(0, MAX_LINES), `and ${lines.length - MAX_LINES} more`];
  return lines;
}
