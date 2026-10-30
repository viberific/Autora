/**
 * Changing a file so that someone else's edits to it survive.
 *
 * The agent used to write files with shell redirects and `sed`, which replace
 * whatever is on disk with what the agent believes is there -- so a change the
 * person saved a moment earlier was silently lost. This is the careful way: the
 * agent says what to replace, and if the file is no longer as the agent last saw
 * it, the two sets of changes are merged (server/merge3.ts) and written only if
 * they do not clash. A clash writes nothing and tells the agent what the person
 * did, so it can decide.
 */

import fs from "node:fs";
import path from "node:path";
import { merge3 } from "./merge3";
import { syntaxNote } from "./syntaxcheck";

export interface TextEdit {
  old: string;
  new: string;
  /** Replace every place it occurs, not only one. */
  all?: boolean;
}

export interface EditArgs {
  path: string;
  edits?: TextEdit[];
  /** A whole file: to make a new one, or (with overwrite) to replace one. */
  content?: string;
  overwrite?: boolean;
}

export interface EditDeps {
  /** Where a relative path starts. */
  root: string;
  /** Folders that are never edited this way (Autora's own data). */
  protect: string[];
  /** The file as the agent last saw it, or null when that is not known. */
  base: (rel: string) => string | null;
  /** Why the person may be working on it now, or null. */
  held: (rel: string) => string | null;
}

export interface EditResult {
  ok: boolean;
  summary: string;
  /** What was written, for the caller to show. */
  wrote?: { path: string; created: boolean };
}

const MAX_BYTES = 1024 * 1024;

/** One place an edit was found, and what goes there. */
interface Spot {
  start: number;
  end: number;
  text: string;
}

type Found = { spots: Spot[]; how: "exact" | "crlf" | "indent" } | { missing: true } | { many: number };

/** Every place `needle` starts in `hay`, not overlapping. */
function places(hay: string, needle: string): number[] {
  const out: number[] = [];
  for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + needle.length)) out.push(at);
  return out;
}

const indentOf = (line: string) => /^[ \t]*/.exec(line)![0];

/**
 * Where an edit goes in `text`: exactly, else with Windows line ends, else line for line with only the indentation
 * different (the commonest near miss: the agent reproduced a block two spaces in from where it is). The last is taken
 * only when every line matches once its spacing is set aside, and the new text is moved in or out by the same amount.
 */
function locate(text: string, e: TextEdit): Found {
  const old = e.old;
  const replacement = String(e.new ?? "");
  const exact = places(text, old);
  const settle = (at: number[], from: string, to: string, how: "exact" | "crlf"): Found =>
    at.length > 1 && !e.all ? { many: at.length } : { spots: at.map((i) => ({ start: i, end: i + from.length, text: to })), how };
  if (exact.length) return settle(exact, old, replacement, "exact");
  if (text.includes("\r\n") && !old.includes("\r") && old.includes("\n")) {
    const crOld = old.replace(/\n/g, "\r\n");
    const at = places(text, crOld);
    if (at.length) return settle(at, crOld, replacement.replace(/\r?\n/g, "\r\n"), "crlf");
  }
  // Line for line, spacing aside.
  const endsLine = old.endsWith("\n");
  const want = (endsLine ? old.slice(0, -1) : old).split("\n").map((l) => l.replace(/\r$/, ""));
  if (!want.some((l) => l.trim())) return { missing: true };
  const lines = text.split("\n");
  const offsets: number[] = [];
  let off = 0;
  for (const l of lines) { offsets.push(off); off += l.length + 1; }
  const hits: number[] = [];
  for (let i = 0; i + want.length <= lines.length; i++) {
    let same = true;
    for (let j = 0; j < want.length && same; j++) same = lines[i + j]!.replace(/\r$/, "").trim() === want[j]!.trim();
    if (same) { hits.push(i); i += want.length - 1; }
  }
  if (!hits.length) return { missing: true };
  if (hits.length > 1 && !e.all) return { many: hits.length };
  const first = want.findIndex((l) => l.trim());
  const spots = hits.map((i): Spot => {
    const theirs = indentOf(lines[i + first]!);
    const ours = indentOf(want[first]!);
    const nl = lines[i]!.endsWith("\r") ? "\r\n" : "\n";
    const body = (endsLine && replacement.endsWith("\n") ? replacement.slice(0, -1) : replacement).split(/\r?\n/)
      .map((l) => (!l.trim() ? l : l.startsWith(ours) ? theirs + l.slice(ours.length) : l))
      .join(nl);
    const last = i + want.length - 1;
    const lineEnd = offsets[last]! + lines[last]!.replace(/\r$/, "").length;
    // The line's own newline goes with it when the old text took it, as an exact match would.
    if (endsLine && last + 1 < lines.length) return { start: offsets[i]!, end: offsets[last + 1]!, text: body + (replacement.endsWith("\n") ? nl : "") };
    return { start: offsets[i]!, end: lineEnd, text: body };
  });
  return { spots, how: "indent" };
}

type Applied = { text: string; notes: string[] } | { error: string; edit: number };

const notFound = (i: number) => `Edit ${i + 1}: that text is not in the file.`;
const tooMany = (i: number, n: number) => `Edit ${i + 1}: that text is in ${n} places. Add more around it to pick one, or set all to replace every one.`;
const looseNote = (i: number, how: string) =>
  how === "indent" ? `edit ${i + 1} matched lines whose indentation differs from what you sent, and was moved to fit` : `edit ${i + 1} was matched across Windows line ends`;

/** One after another, each in the text the edits before it left: for edits that build on each other. */
function inTurn(text: string, edits: TextEdit[]): Applied {
  let out = text;
  const notes: string[] = [];
  for (const [i, e] of edits.entries()) {
    const found = locate(out, e);
    if ("missing" in found) return { error: notFound(i), edit: i };
    if ("many" in found) return { error: tooMany(i, found.many), edit: i };
    for (const s of [...found.spots].sort((a, b) => b.start - a.start)) out = out.slice(0, s.start) + s.text + out.slice(s.end);
    if (found.how !== "exact") notes.push(looseNote(i, found.how));
  }
  return { text: out, notes };
}

/**
 * The edits made to a file. Models write every edit of a call against the file as they read it, so each is found in
 * that text first, and they are made together when they do not touch; only when that fails are they made in turn (an
 * edit that names what an earlier one wrote). In the logs of 0.9.236-0.9.303, edit 2 or 3 of a call failed "not in the
 * file" while the text was there: an earlier edit of the same call had already changed it.
 */
function apply(text: string, edits: TextEdit[]): Applied {
  for (const [i, e] of edits.entries()) {
    if (typeof e?.old !== "string" || e.old === "") return { error: `Edit ${i + 1} has no "old" text: say exactly what to replace.`, edit: i };
  }
  const found = edits.map((e) => locate(text, e));
  const spots = found.flatMap((f, i) => ("spots" in f ? f.spots.map((s) => ({ ...s, edit: i })) : []));
  const whole = found.every((f) => "spots" in f);
  const sorted = [...spots].sort((a, b) => a.start - b.start);
  const clash = sorted.findIndex((s, k) => k > 0 && s.start < sorted[k - 1]!.end);
  if (whole && clash < 0) {
    let out = text;
    for (const s of [...sorted].reverse()) out = out.slice(0, s.start) + s.text + out.slice(s.end);
    const notes = found.flatMap((f, i) => ("how" in f && f.how !== "exact" ? [looseNote(i, f.how)] : []));
    return { text: out, notes };
  }
  const turn = inTurn(text, edits);
  if ("text" in turn) return turn;
  // Neither way works: say why in the terms that help.
  if (whole && clash >= 0) {
    const a = sorted[clash - 1]!, b = sorted[clash]!;
    const line = text.slice(0, b.start).split("\n").length;
    return { error: `Edits ${Math.min(a.edit, b.edit) + 1} and ${Math.max(a.edit, b.edit) + 1} change the same text (around line ${line}): make them one edit, or name in the later one the text the earlier one leaves.`, edit: b.edit };
  }
  const bad = found.findIndex((f) => !("spots" in f));
  if (bad >= 0 && bad !== turn.edit) {
    const f = found[bad]!;
    return { error: "many" in f ? tooMany(bad, f.many) : notFound(bad), edit: bad };
  }
  return turn;
}

/** The lines nearest to what the failing edit was looking for, to help it find the place. */
function hint(disk: string, edit: TextEdit | undefined): string {
  const squash = (t: string) => t.replace(/\s+/g, "");
  const want = squash(String(edit?.old ?? "").split("\n").find((l) => l.trim().length > 3) ?? "").slice(0, 16);
  if (!want) return "";
  const lines = disk.split("\n");
  // Whitespace is ignored: a near miss is usually spacing or indentation.
  // The whole start of it first, then less and less: a line the person has
  // since changed still begins the same way.
  let at = -1;
  for (const len of [16, 12, 9, 7]) {
    at = lines.findIndex((l) => squash(l).includes(want.slice(0, len)));
    if (at >= 0) break;
  }
  if (at < 0) return "";
  return ` Near it the file has:\n${lines.slice(Math.max(0, at - 1), at + 2).map((l, i) => `  ${Math.max(0, at - 1) + i + 1}: ${l.slice(0, 120)}`).join("\n")}`;
}

export function editFile(args: EditArgs, deps: EditDeps): EditResult {
  const given = String(args.path ?? "").trim();
  if (!given) return { ok: false, summary: "Say which file: path." };
  const full = path.resolve(deps.root, given);
  const rel = path.relative(deps.root, full).split(path.sep).join("/") || given;
  if (deps.protect.some((p) => full === path.resolve(p) || full.startsWith(path.resolve(p) + path.sep))) {
    return { ok: false, summary: `${given} is Autora's own data, which is not edited this way.` };
  }
  let stat: fs.Stats | null = null;
  try {
    stat = fs.statSync(full);
  } catch {
    stat = null;
  }
  if (stat?.isDirectory()) return { ok: false, summary: `${given} is a folder.` };
  if (stat && stat.size > MAX_BYTES) return { ok: false, summary: `${given} is over 1 MB; edit it with the terminal.` };
  let disk: string | null = null;
  if (stat) {
    try {
      const data = fs.readFileSync(full);
      if (data.subarray(0, 4096).includes(0)) return { ok: false, summary: `${given} is not a text file.` };
      disk = data.toString("utf8");
    } catch (err) {
      return { ok: false, summary: `Could not read ${given}: ${String((err as Error).message).split("\n")[0]}` };
    }
  }

  const base = disk !== null ? deps.base(rel) : null;
  /** The file as the agent saw it, when the person has changed it since. */
  const diverged = disk !== null && base !== null && base !== disk;
  let ours: string;
  let note = "";
  /** Said when an edit was matched other than exactly. */
  let loose = "";
  /** The agent's edit only made sense against the file as it is now: it was working from that. */
  let fromDisk = false;

  if (typeof args.content === "string") {
    if (disk !== null && !args.overwrite) {
      return { ok: false, summary: `${given} already exists. Change it with edits, or set overwrite to replace the whole file.` };
    }
    if (args.content.length > MAX_BYTES) return { ok: false, summary: "That is over 1 MB: write it in parts with the terminal." };
    ours = args.content;
  } else if (Array.isArray(args.edits) && args.edits.length > 0) {
    if (disk === null) return { ok: false, summary: `There is no file ${given}. To make one, give content.` };
    const view = diverged ? base! : disk;
    let made = apply(view, args.edits);
    if ("error" in made && diverged) {
      // The agent may be working from the newer file: try it as the person left it.
      const direct = apply(disk, args.edits);
      if (!("error" in direct)) {
        made = direct;
        fromDisk = true;
      }
    }
    if ("error" in made) return { ok: false, summary: `${made.error}${hint(disk, args.edits[made.edit])}` };
    ours = made.text;
    if (made.notes.length) loose = ` (${made.notes.join("; ")}: check it.)`;
  } else {
    return { ok: false, summary: "Give edits (what to replace with what) or content (a whole file)." };
  }

  let write = ours;
  if (diverged && disk !== null && !fromDisk) {
    /* The person changed the file since the agent last read it: put the two
       sets of changes together. (If the agent's edit only fits the newer file,
       it was working from that one, and is written as it stands.) */
    const merged = merge3(base!, ours, disk);
    if (merged.conflicts.length > 0) {
      const c = merged.conflicts[0];
      return {
        ok: false,
        summary:
          `Not written: the person changed ${given} since you last read it, and their change clashes with yours` +
          `${merged.conflicts.length > 1 ? ` in ${merged.conflicts.length} places` : ""}. Around line ${c.line}:\n` +
          `  you were changing:  ${c.base.slice(0, 4).map((l) => JSON.stringify(l.slice(0, 100))).join(" ")}\n` +
          `  you wanted:         ${c.ours.slice(0, 4).map((l) => JSON.stringify(l.slice(0, 100))).join(" ")}\n` +
          `  they have:          ${c.theirs.slice(0, 4).map((l) => JSON.stringify(l.slice(0, 100))).join(" ")}\n` +
          "Read the file as it is now, work with what they wrote, and make your change on top of it -- or leave it to them.",
      };
    }
    write = merged.text;
    note = merged.withTheirs ? " Their changes to the file since you last read it are kept alongside yours." : "";
  }

  const why = deps.held(rel);
  if (why && disk !== null) {
    note += " The person was working in this file moments ago and may still be: read it again before your next change.";
  }
  try {
    fs.mkdirSync(path.dirname(full), { recursive: true });
    const tmp = path.join(path.dirname(full), `.${path.basename(full)}.autora-${process.pid}.tmp`);
    fs.writeFileSync(tmp, write, { mode: stat ? stat.mode & 0o777 : 0o644 });
    fs.renameSync(tmp, full);
  } catch (err) {
    return { ok: false, summary: `Could not write ${given}: ${String((err as Error).message).split("\n")[0]}` };
  }
  /* Whether the file still parses, said now rather than a round later (server/syntaxcheck.ts). */
  note += syntaxNote(full, disk, write);
  const was = (disk ?? "").split("\n").length, now = write.split("\n").length;
  return {
    ok: true,
    wrote: { path: rel, created: disk === null },
    summary:
      `${disk === null ? "Created" : "Edited"} ${given}` +
      `${args.edits?.length ? ` (${args.edits.length} edit${args.edits.length === 1 ? "" : "s"})` : ""}: ${disk === null ? `${now} lines` : `${was} -> ${now} lines`}.${loose}${note}`,
  };
}
