/**
 * Autora Photo: the photo editing window, and the agent's hands on the same picture.
 *
 * Autora Photo is PhotoCraft (github.com/storytold/photocraft, MIT or Apache-2.0), an image editor written in Rust, built by
 * scripts/build-photo.mjs from the commit in photo/PIN.json into dist/photo/. It is two programs:
 *
 *   - its editor, WebAssembly in a frame beside the conversation (components/PhotoWindow.tsx), which the person works in:
 *     layers, masks, adjustment layers, type, brushes, filters, real PSD files;
 *   - its headless command line (`photocraft-cli serve`), which the agent's `photo_*` tools run: the same command
 *     registry the editor's menus call, so anything a person can click the agent can do.
 *
 * They share one file per chat, `work.pcraft` (PhotoCraft's own layered format), kept on this server:
 *
 *   - the agent's tools open it, change it and save it (`runPhotoTool`), and the window is told, and reloads it;
 *   - except with Visible work on and the window open: then the agent's edit is done in the window, by hand, as a person
 *     does it (`byHand`: its cursor goes through All tools and the command's dialog, see photo/overlay/autora.rs), and
 *     the window sends the picture back when it is done;
 *   - the person works in the window as in the app on its own, and a moment after they stop the editor sends the file
 *     back (`PUT /api/photo/:session/doc`), so the agent's next call sees what they did.
 *
 * Who made a change travels with it (`by`): the window reloads the picture for the agent's changes and never for its own
 * person's, so a brush stroke in progress is not interrupted by an echo of itself.
 *
 * The editor is a page of this origin in a frame (served below with a CSP); the window talks to it by postMessage only.
 * The command line gets a folder of its own per chat as its only file access.
 */
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { createHandshake } from "./handshake";
import express, { type Express, type Request, type Response } from "express";
import fs from "node:fs";
import path from "node:path";
import { keepCopy, saveArtifact } from "./artifacts";
import { addCommand, logText, openPersonRun, type OfficeCommand } from "./commandlog";
import { describePhotoChange } from "./photolog";
import { chatTitle } from "./folders";
import { readFileRef, FileRefError } from "./fileref";
import type { ChatImage } from "./llm";
import { pickText, rememberPick, type Pick } from "./picked";
import { stateDir } from "./state";
import { staticDir } from "./staticfiles";

const validSession = (id: string) => /^[A-Za-z0-9_-]{1,80}$/.test(id);

/** The folder of a chat's picture: the working file, and whatever the command line is handed to read. */
const folder = (session: string) => path.join(stateDir(), "photo", session);
const WORK = "work.pcraft";
const workFile = (session: string) => path.join(folder(session), WORK);

/** Large enough for a photograph in layers; the editor itself holds the picture in memory too. */
const MAX_DOC = 512 * 1024 * 1024;

// ---------------------------------------------------------------- the build --

/** Where the build is: AUTORA_PHOTO_DIR, or dist/photo beside the server. */
function photoDir(): string | null {
  const dirs = [process.env.AUTORA_PHOTO_DIR, path.join(process.cwd(), "dist", "photo")].filter((d): d is string => Boolean(d));
  return dirs.find((d) => fs.existsSync(path.join(d, "web", "index.html")) || fs.existsSync(path.join(d, "native"))) ?? null;
}

/** The editor, built. */
const hasEditor = (): boolean => {
  const dir = photoDir();
  return Boolean(dir && fs.existsSync(path.join(dir, "web", "index.html")));
};

/** PhotoCraft's command line, built for this CPU (or for this machine). */
function cliFile(): string | null {
  const dir = photoDir();
  if (!dir) return null;
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return [`photocraft-cli-${arch}`, "photocraft-cli"].map((n) => path.join(dir, "native", n)).find((p) => fs.existsSync(p)) ?? null;
}

/** Whether the photo tools can work: the editor and the command line are both built into this server. */
export const photoAvailable = (): boolean => hasEditor() && cliFile() !== null;

// -------------------------------------------------------------------- state --

/** What the page knows about the window. */
interface PhotoState {
  open: boolean;
  /** When it was opened, which orders it among the other windows. */
  since?: number;
  /** Goes up on every change to the picture, by anyone. */
  rev?: number;
  /** Who made the latest change. */
  by?: "agent" | "person";
  /** The picture's size and layer count, once there is one. */
  size?: { w: number; h: number };
  layers?: number;
  /** The revision the window made itself, by the agent's hand: it has it already, so it does not load it again. */
  hand?: number;
}

interface Entry {
  open: boolean;
  since: number;
  rev: number;
  by: "agent" | "person";
  size?: { w: number; h: number };
  layers?: number;
  /** The revision the window made by the agent's hand (it has it), or -1. */
  hand: number;
  /** Calls to the command line for this chat, one at a time. */
  line: Promise<unknown>;
  /** The layer the person is on, and when it was said; not kept on disk. */
  pick?: Pick;
  /** Every change to the picture as a command (who, what), oldest first. See commandlog.ts. */
  log: OfficeCommand[];
  lseq: number;
  /** What the command line read of the picture as the last change left it, and just before each command: for the log's words. */
  reading?: Inspected;
  readings: Map<number, Inspected | undefined>;
}

const entries = new Map<string, Entry>();
const listeners = new Set<(session: string) => void>();

const stateFile = (session: string) => path.join(folder(session), "state.json");

function entryFor(session: string): Entry {
  let entry = entries.get(session);
  if (!entry) {
    let saved: { open?: boolean; since?: number; size?: { w: number; h: number }; layers?: number; log?: OfficeCommand[]; lseq?: number } = {};
    if (validSession(session)) {
      try {
        saved = JSON.parse(fs.readFileSync(stateFile(session), "utf8"));
      } catch {
        // no state yet
      }
    }
    entry = { open: Boolean(saved.open), since: saved.since ?? 0, rev: 0, by: "agent", size: saved.size, layers: saved.layers, hand: -1, line: Promise.resolve(), log: Array.isArray(saved.log) ? saved.log : [], lseq: Number(saved.lseq) || 0, readings: new Map() };
    entries.set(session, entry);
  }
  return entry;
}

function remember(session: string) {
  const e = entryFor(session);
  try {
    fs.mkdirSync(folder(session), { recursive: true, mode: 0o700 });
    fs.writeFileSync(stateFile(session), JSON.stringify({ open: e.open, since: e.since, size: e.size, layers: e.layers, log: e.log, lseq: e.lseq }), { mode: 0o600 });
  } catch {
    // The window works without it; it only forgets that it was open.
  }
}

function changed(session: string) {
  for (const fn of listeners) fn(session);
}

function setOpen(session: string, open: boolean) {
  const e = entryFor(session);
  if (e.open === open) return;
  e.open = open;
  e.since = open ? Date.now() : e.since;
  remember(session);
  changed(session);
}

export function photoState(session: string): PhotoState {
  if (!validSession(session)) return { open: false };
  const e = entryFor(session);
  if (!e.open) return { open: false };
  return {
    open: true, since: e.since, rev: e.rev, by: e.by,
    ...(e.size ? { size: e.size } : {}), ...(e.layers !== undefined ? { layers: e.layers } : {}), ...(e.hand === e.rev ? { hand: e.hand } : {}),
  };
}

/** Told after every change to a chat's window or picture, so the page can be told. */
export function onPhotoChange(fn: (session: string) => void) {
  listeners.add(fn);
}

/** The chat is gone: let go of its picture. */
export function dropPhoto(session: string) {
  entries.delete(session);
  if (!validSession(session)) return;
  fs.rmSync(folder(session), { recursive: true, force: true });
}

// ------------------------------------------------------------ the command line --

interface Reply {
  id: number;
  ok: boolean;
  result?: any;
  error?: string;
}

/**
 * One batch of requests to a fresh `photocraft-cli serve`, whose only file access is the chat's folder: the requests go
 * in as lines, and the answers come back by id. The process lives for the call. Resolves with the answers in order;
 * a request that failed has `ok: false`, and later ones still ran.
 */
function serve(session: string, requests: Array<{ method: string; params?: unknown }>, opts: { timeoutMs?: number } = {}): Promise<Reply[]> {
  const exe = cliFile();
  if (!exe) return Promise.reject(new Error("Autora Photo's command line is not built into this server."));
  const dir = folder(session);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const input = requests.map((r, i) => JSON.stringify({ id: i + 1, method: r.method, params: r.params ?? {} })).join("\n") + "\n";
  return new Promise((resolve, reject) => {
    const child = execFile(
      exe,
      ["serve", "--automation-read-root", dir, "--automation-write-root", dir],
      { cwd: dir, timeout: opts.timeoutMs ?? 180_000, maxBuffer: 256 * 1024 * 1024, env: { ...process.env, HOME: dir } },
      (err, stdout, stderr) => {
        const replies: Reply[] = [];
        for (const line of String(stdout).split("\n")) {
          const text = line.trim();
          if (!text.startsWith("{")) continue;
          try {
            replies.push(JSON.parse(text) as Reply);
          } catch {
            // not a reply
          }
        }
        if (replies.length === 0 && err) return reject(new Error(String(stderr).trim().slice(-600) || err.message));
        replies.sort((a, b) => a.id - b.id);
        resolve(replies);
      },
    );
    child.stdin?.end(input);
  });
}

/** The command line's calls for one chat run one after another, so two never open the same file at once. */
function inLine<T>(session: string, work: () => Promise<T>): Promise<T> {
  const e = entryFor(session);
  const next = e.line.then(work, work);
  e.line = next.catch(() => undefined);
  return next;
}

const first = (replies: Reply[], what: string): any => {
  const r = replies[0];
  if (!r) throw new Error(`${what}: the command line gave no answer.`);
  if (!r.ok) throw new Error(`${what}: ${r.error ?? "it did not work."}`);
  return r.result;
};

/** What the picture is, from `doc.inspect`: its size, mode and the layers as a tree of one line each. */
interface Inspected {
  name?: string;
  size?: { width: number; height: number };
  width?: number;
  height?: number;
  layers?: unknown[];
  [k: string]: unknown;
}

function sizeOf(doc: Inspected): { w: number; h: number } | undefined {
  const w = doc.size?.width ?? doc.width;
  const h = doc.size?.height ?? doc.height;
  return typeof w === "number" && typeof h === "number" ? { w, h } : undefined;
}

function countLayers(layers: unknown): number {
  if (!Array.isArray(layers)) return 0;
  let n = 0;
  for (const l of layers) {
    n += 1;
    if (l && typeof l === "object") n += countLayers((l as { children?: unknown }).children);
  }
  return n;
}

/** What a change is, for the log: who made it, what kind, and in a line. */
interface Said {
  who: "agent" | "person";
  name: OfficeCommand["name"];
  line: string;
}

/** Note a new state of the picture: from the agent's tools, or from the person's window. `said` makes it a command in the log. */
function noteChange(session: string, by: "agent" | "person", doc?: Inspected, said?: Said) {
  const e = entryFor(session);
  e.rev += 1;
  e.by = by;
  if (doc) {
    e.size = sizeOf(doc) ?? e.size;
    e.layers = countLayers(doc.layers);
  }
  if (said) logCommand(session, e, doc, said);
  if (doc) e.reading = doc;
  remember(session);
  changed(session);
}

// ------------------------------------------------------- the command log --

/*
 * The picture is a file the server holds (work.pcraft), so a command's "before" is a copy of that file taken just before the
 * change: `stage` copies it aside, and the change that follows keeps the copy under the command's number. Copies survive a
 * restart (they are files), newest 10 and 300 MB of them; going back to before a command puts its copy back.
 */

const versionsDir = (session: string) => path.join(folder(session), "versions");
const versionFile = (session: string, n: number) => path.join(versionsDir(session), `v${n}.pcraft`);
const pendingFile = (session: string) => path.join(versionsDir(session), "pending.pcraft");
const KEPT_VERSIONS = 10;
const KEPT_BYTES = 300 * 1024 * 1024;
/** The person's changes within this long of their last are one command: a brush stroke is many saves. */
const RUN_MS = 30_000;

const commandListeners = new Set<(session: string, entry: OfficeCommand) => void>();
/** Told of every command made on a chat's picture (the agent's, the person's, a revert), for the event log. */
export function onPhotoCommand(fn: (session: string, entry: OfficeCommand) => void) {
  commandListeners.add(fn);
}

/** Copy the picture as it is now aside, before something changes it (nothing, when there is no picture yet). */
function stage(session: string): void {
  try {
    fs.mkdirSync(versionsDir(session), { recursive: true, mode: 0o700 });
    if (fs.existsSync(workFile(session))) fs.copyFileSync(workFile(session), pendingFile(session));
    else fs.rmSync(pendingFile(session), { force: true });
  } catch (err) {
    console.warn(`[photodesk] ${session}: could not keep the picture aside: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const sameBytes = (a: string, b: string): boolean => {
  try {
    return fs.statSync(a).size === fs.statSync(b).size && fs.readFileSync(a).equals(fs.readFileSync(b));
  } catch {
    return false;
  }
};

/** Keep only the newest copies, and no more than the byte cap. */
function trimVersions(session: string, e: Entry): void {
  let total = 0;
  const live = e.log.map((c) => c.n).filter((n) => fs.existsSync(versionFile(session, n))).sort((a, b) => b - a);
  live.forEach((n, i) => {
    const size = fs.statSync(versionFile(session, n)).size;
    total += size;
    if (i >= KEPT_VERSIONS || total > KEPT_BYTES) fs.rmSync(versionFile(session, n), { force: true });
  });
}

function logCommand(session: string, e: Entry, doc: Inspected | undefined, said: Said): void {
  const staged = fs.existsSync(pendingFile(session));
  // The window sends the picture now and then as it is: nothing changed, nothing to log.
  if (said.who === "person" && said.name === "person_edit" && staged && sameBytes(pendingFile(session), workFile(session))) {
    fs.rmSync(pendingFile(session), { force: true });
    return;
  }
  const last = e.log[e.log.length - 1];
  const run = said.who === "person" && said.name === "person_edit" && last && Date.now() - last.at < RUN_MS ? openPersonRun(e.log, true) : null;
  if (run) {
    // The same run of the person's painting: one command, said again from where it began.
    const lines = describePhotoChange(e.readings.get(run.n), doc);
    run.summary = (said.line && lines.length === 1 && lines[0] === "changed the picture" ? said.line : lines.join("; ")).slice(0, 400);
    run.at = Date.now();
    run.rev = e.rev;
    fs.rmSync(pendingFile(session), { force: true });
    for (const fn of commandListeners) fn(session, run);
    return;
  }
  const entry = addCommand(e.log, ++e.lseq, { who: said.who, name: said.name, at: Date.now(), rev: e.rev, before: staged ? e.lseq : null, summary: said.line });
  if (staged) {
    try { fs.renameSync(pendingFile(session), versionFile(session, entry.n)); } catch { entry.before = null; }
  }
  e.readings.set(entry.n, e.reading);
  while (e.readings.size > 40) e.readings.delete(e.readings.keys().next().value as number);
  trimVersions(session, e);
  for (const fn of commandListeners) fn(session, entry);
}

/** The commands made on a chat's picture, oldest first. */
export function photoLog(session: string): OfficeCommand[] {
  return validSession(session) ? [...entryFor(session).log] : [];
}

/**
 * Go back to just before command n: its copy of the picture goes back in place, as a new change that can itself be taken back.
 * The person may go back to before any command; the agent only to before one of its own with none of the person's after it
 * (the look, colour and composition are theirs). Null when done, else why not. The caller holds the chat's line (inLine).
 */
async function revertPhotoCommandHeld(session: string, n: number, who: "agent" | "person"): Promise<string | null> {
  if (!validSession(session)) return "Autora Photo needs a chat to work in.";
  const e = entryFor(session);
  const cmd = e.log.find((c) => c.n === n);
  if (!cmd) return "That command is not in the log.";
  if (who === "agent" && e.log.some((c) => c.n >= n && c.who === "person")) {
    return "That command, or one after it, is the person's own work, and the look of the picture is theirs: you do not take it back. Say what you would change and let them undo it in the window, or ask them.";
  }
  if (cmd.before === null) return "That command began the picture; there is nothing before it to go back to.";
  const file = versionFile(session, n);
  if (!fs.existsSync(file)) return "The picture from before that command is no longer kept (the last 10 are, up to 300 MB).";
  stage(session);
  const doc = await keepFromWindow(session, fs.readFileSync(file));
  // The window takes it as the agent's change whoever asked, or the person's own window would not load it.
  noteChange(session, "agent", doc, { who, name: "revert", line: `went back to before command ${n} (${cmd.summary.slice(0, 80)})` });
  return null;
}

// ------------------------------------------------------------------ by hand --

/* With Visible work on, the agent's edit is done in the window, by hand (photo/overlay/autora.rs): the window is sent it,
   the first window of the chat to claim it does it (the same chat open in two tabs must not do it twice), and it sends
   back the picture and what each command did. No window to claim it (none open, or the editor not started) means nobody
   is watching: the edit runs here, at speed, as with Visible work off. */

let visible: () => boolean = () => false;

type HandResult = { command?: string; ok?: boolean; error?: string; how?: string };
type Handed = { results: HandResult[]; bytes: Buffer | null; error?: string };
/** The offers to the window (server/handshake.ts). */
const hs = createHandshake();

/** How long a window has to take the edit before it is done here instead. */
const CLAIM_MS = 4_000;
/** A person's pace: seconds per command (find it, open it, set it, OK), and some for a filter that runs a while. */
const handTime = (n: number) => 30_000 + n * 20_000;

/** The edit, done in the window by the agent's hand; null when no window took it. */
async function byHand(session: string, commands: Array<{ command: string; params?: unknown }>): Promise<Handed | null> {
  if (!visible() || !entryFor(session).open) return null;
  // A window that has only just mounted lets the first one go by: it is sent again until one takes it, or nobody does.
  const out = await hs.offer<Handed>(session, { type: "photodesk.hand", session, commands: commands.map((c) => ({ id: c.command, params: c.params ?? {} })) }, {
    claimMs: CLAIM_MS,
    replyMs: handTime(commands.length),
    // Slow is not failed: the hand may be in the middle of it, and what it did stays in the window.
    timeoutError: "The edit in the window took longer than expected. That means it was slow, not that it failed: what was done is in the window. Look with photo_info before you repeat any of it.",
  });
  return out.taken ? out.value : null;
}

/** Keep a picture that came from the window: it must be a PhotoCraft file, so the command line opens it first. */
async function keepFromWindow(session: string, body: Buffer): Promise<Inspected | undefined> {
  fs.mkdirSync(folder(session), { recursive: true, mode: 0o700 });
  if (!cliFile()) {
    fs.writeFileSync(workFile(session), body, { mode: 0o600 });
    return undefined;
  }
  const incoming = `put-${crypto.randomBytes(4).toString("hex")}.pcraft`;
  fs.writeFileSync(path.join(folder(session), incoming), body, { mode: 0o600 });
  try {
    const r = await serve(session, [{ method: "doc.open", params: { path: incoming } }, { method: "doc.inspect" }], { timeoutMs: 60_000 });
    first(r, "That is not a PhotoCraft picture");
    const doc = first(r.slice(1), "Could not read the picture") as Inspected;
    fs.renameSync(path.join(folder(session), incoming), workFile(session));
    return doc;
  } finally {
    fs.rmSync(path.join(folder(session), incoming), { force: true });
  }
}

// -------------------------------------------------------------------- tools --

/** The most a tool result may say, in characters: a layer tree or the command list can be large. */
const MOST = 20_000;

const cut = (text: string, hint: string) => (text.length > MOST ? `${text.slice(0, MOST)}\n[cut: ${text.length} characters. ${hint}]` : text);

const FORMATS: Record<string, { mime: string; ext: string }> = {
  png: { mime: "image/png", ext: "png" },
  jpg: { mime: "image/jpeg", ext: "jpg" },
  jpeg: { mime: "image/jpeg", ext: "jpg" },
  webp: { mime: "image/webp", ext: "webp" },
  tif: { mime: "image/tiff", ext: "tif" },
  tiff: { mime: "image/tiff", ext: "tif" },
  psd: { mime: "image/vnd.adobe.photoshop", ext: "psd" },
  pcraft: { mime: "application/octet-stream", ext: "pcraft" },
};

interface PhotoHooks {
  /** Show a saved file in the thread. */
  showFile?: (file: { id: string; name: string; mime: string; size: number }) => void;
  /** Show a picture in the thread. */
  showImage?: (data: Buffer, alt: string, size?: { w: number; h: number }) => void;
  /** A folder to read relative file names in. */
  cwd: string;
}

type PhotoOutcome = { ok: boolean; summary: string; preview?: string; images?: ChatImage[] };

const hasPicture = (session: string) => fs.existsSync(workFile(session));

/** The name a file is saved under: safe, with the extension its format needs. */
function exportName(wanted: unknown, ext: string, fallback: string): string {
  const base = (typeof wanted === "string" && wanted.trim() ? wanted.trim() : fallback)
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-")
    .replace(/\.(png|jpe?g|webp|tiff?|psd|pcraft)$/i, "")
    .slice(0, 80);
  return `${base || fallback}.${ext}`;
}

/**
 * Runs one `photo_*` tool on the chat's picture and opens the window, so the person watches it happen.
 * Never throws: a bad call comes back as { ok: false, summary } saying what was wrong and what to try.
 */
export async function runPhotoTool(session: string, tool: string, args: Record<string, any>, hooks: PhotoHooks): Promise<PhotoOutcome> {
  if (!validSession(session)) return { ok: false, summary: "Autora Photo needs a chat to work in." };
  if (!photoAvailable()) return { ok: false, summary: "Autora Photo is not built into this server." };
  try {
    return await inLine(session, async () => {
      const mine = entryFor(session);
      const none = "There is no picture yet. Open one with photo_open (a file, or `new` for a blank canvas).";

      switch (tool) {
        case "photo_open": {
          fs.mkdirSync(folder(session), { recursive: true, mode: 0o700 });
          if (args.file !== undefined && args.new !== undefined) return { ok: false, summary: "Give either `file` or `new`, not both." };
          if (args.file !== undefined) {
            const given = readFileRef(args.file, hooks.cwd, "the picture", "photo_open");
            if (given.data.length > MAX_DOC) return { ok: false, summary: "That file is too large for Autora Photo." };
            const ext = (path.extname(given.name).slice(1) || "png").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8) || "png";
            const input = `in-${crypto.randomBytes(4).toString("hex")}.${ext}`;
            fs.writeFileSync(path.join(folder(session), input), given.data, { mode: 0o600 });
            stage(session);
            try {
              const r = await serve(session, [
                { method: "doc.open", params: { path: input } },
                { method: "doc.save", params: { path: WORK } },
                { method: "doc.inspect" },
              ]);
              first(r, `Could not open ${given.name}`);
              first(r.slice(1), "Could not keep the picture");
              const doc = first(r.slice(2), "Could not read the picture") as Inspected;
              mine.by = "agent";
              setOpen(session, true);
              noteChange(session, "agent", doc, { who: "agent", name: "open", line: `opened ${given.name.slice(0, 80)}` });
              return { ok: true, summary: `Opened ${given.name} in Autora Photo.\n${cut(JSON.stringify(doc), "photo_info lists the layers.")}`, preview: given.name };
            } finally {
              fs.rmSync(path.join(folder(session), input), { force: true });
            }
          }
          if (args.new !== undefined) {
            const n = (args.new && typeof args.new === "object" ? args.new : {}) as Record<string, unknown>;
            const params = {
              width: Math.min(Math.max(Math.round(Number(n.width) || 1920), 1), 16384),
              height: Math.min(Math.max(Math.round(Number(n.height) || 1080), 1), 16384),
              mode: "rgb",
              depth: 8,
              background: typeof n.background === "string" ? n.background : "white",
            };
            stage(session);
            const r = await serve(session, [{ method: "doc.new", params }, { method: "doc.save", params: { path: WORK } }, { method: "doc.inspect" }]);
            first(r, "Could not make a canvas");
            first(r.slice(1), "Could not keep the picture");
            const doc = first(r.slice(2), "Could not read the picture") as Inspected;
            mine.by = "agent";
            setOpen(session, true);
            noteChange(session, "agent", doc, { who: "agent", name: "open", line: `started a new ${params.width}x${params.height} canvas` });
            return { ok: true, summary: `A new ${params.width}x${params.height} canvas is open in Autora Photo.`, preview: `${params.width}x${params.height}` };
          }
          // Just the window, on whatever is there.
          mine.by = "agent";
          setOpen(session, true);
          changed(session);
          if (!hasPicture(session)) return { ok: true, summary: `Autora Photo is open, with no picture in it yet. ${none}`, preview: "opened" };
          const r = await serve(session, [{ method: "doc.open", params: { path: WORK } }, { method: "doc.inspect" }]);
          first(r, "Could not open the picture");
          const doc = first(r.slice(1), "Could not read the picture") as Inspected;
          return { ok: true, summary: cut(JSON.stringify(doc), "photo_info lists the layers."), preview: "opened" };
        }

        case "photo_history": {
          const action = String(args.action ?? "log");
          if (action === "log") {
            const since = Number(args.since_revision);
            return { ok: true, summary: logText(mine.log, Number.isFinite(since) && since > 0 ? since : 0, "picture"), preview: "history log" };
          }
          if (action === "revert") {
            const n = Number(args.n);
            if (!Number.isInteger(n)) return { ok: false, summary: "revert needs n, a command number from the log." };
            const problem = await revertPhotoCommandHeld(session, n, "agent");
            return problem
              ? { ok: false, summary: problem }
              : { ok: true, summary: `The picture is back to just before command ${n}. That is a new change on top, so it can be taken back; photo_history log shows it as a revert.`, preview: `revert ${n}` };
          }
          return { ok: false, summary: "action is log or revert." };
        }

        case "photo_info": {
          if (!hasPicture(session)) return { ok: false, summary: none };
          const r = await serve(session, [{ method: "doc.open", params: { path: WORK } }, { method: "doc.inspect" }]);
          first(r, "Could not open the picture");
          const doc = first(r.slice(1), "Could not read the picture") as Inspected;
          return { ok: true, summary: cut(JSON.stringify(doc), "Ask for less: the layer tree is what is long."), preview: "info" };
        }

        case "photo_look": {
          if (!hasPicture(session)) return { ok: false, summary: none };
          const side = Math.min(Math.max(Math.round(Number(args.max_side) || 1024), 64), 2048);
          const r = await serve(session, [{ method: "doc.open", params: { path: WORK } }, { method: "doc.render", params: { maxSide: side } }, { method: "doc.inspect" }]);
          first(r, "Could not open the picture");
          const shot = first(r.slice(1), "Could not draw the picture") as { base64?: string };
          const doc = first(r.slice(2), "Could not read the picture") as Inspected;
          if (!shot.base64) return { ok: false, summary: "The command line drew nothing." };
          const png = Buffer.from(shot.base64, "base64");
          const size = sizeOf(doc);
          hooks.showImage?.(png, "The picture in Autora Photo", size);
          return {
            ok: true,
            summary: `The picture${size ? ` (${size.w}x${size.h})` : ""} is in this result and shown in the conversation.`,
            preview: "looked",
            images: [{ mime: "image/png", data: shot.base64 }],
          };
        }

        case "photo_commands": {
          const filter = typeof args.filter === "string" ? args.filter.trim() : "";
          const r = await serve(session, [{ method: "engine.commands", params: filter ? { filter } : {} }]);
          const list = first(r, "Could not list the commands");
          const rows: unknown[] = Array.isArray(list) ? list : Array.isArray(list?.commands) ? list.commands : [];
          const lines = rows.map((c: any) => {
            const params = c?.params && typeof c.params === "object" ? JSON.stringify(c.params) : c?.params ? String(c.params) : "";
            return `${c?.id ?? "?"}${c?.label ? ` -- ${c.label}` : ""}${params && params !== "{}" ? ` ${params}` : ""}${c?.enabled === false ? " [not available now]" : ""}`;
          });
          if (lines.length === 0) return { ok: true, summary: filter ? `No command matches "${filter}".` : "No commands.", preview: filter || "commands" };
          return { ok: true, summary: cut(lines.join("\n"), "Narrow it with a longer `filter`."), preview: `${lines.length} commands` };
        }

        case "photo_edit": {
          if (!hasPicture(session)) return { ok: false, summary: none };
          const steps = Array.isArray(args.commands) ? args.commands : [];
          if (steps.length === 0) return { ok: false, summary: "photo_edit needs `commands`: a list of { id, params } (photo_commands lists the ids)." };
          if (steps.length > 200) return { ok: false, summary: "At most 200 commands in one call." };
          const batch = steps.map((s: any) => {
            const id = typeof s === "string" ? s : s?.id;
            if (typeof id !== "string" || !id) throw new Error("every command needs an `id`");
            return { command: id, ...(s && typeof s === "object" && s.params && typeof s.params === "object" ? { params: s.params } : {}) };
          });
          stage(session);
          const applied = `applied ${batch.slice(0, 4).map((b: { command: string }) => b.command).join(", ")}${batch.length > 4 ? ` and ${batch.length - 4} more` : ""}`;
          const hand = await byHand(session, batch);
          if (hand && (hand.bytes || hand.results.length > 0)) {
            const said = hand.results
              .map((x, i) => `${i + 1}. ${x.command ?? batch[i]?.command ?? "?"}: ${x.ok === false ? `FAILED -- ${x.error ?? "it did not work"}` : x.how === "direct" ? "done (as the editor's command: it has no tile in All tools)" : "done by hand in the window"}`)
              .join("\n");
            if (hand.bytes) {
              const doc = await keepFromWindow(session, hand.bytes);
              mine.by = "agent";
              // The window made this revision itself: it is told so, and does not load it again.
              mine.hand = mine.rev + 1;
              noteChange(session, "agent", doc, { who: "agent", name: "agent_edit", line: applied });
            }
            const bad = hand.results.findIndex((x) => x.ok === false);
            if (bad >= 0) {
              return { ok: false, summary: `Stopped at command ${bad + 1} (${batch[bad]?.command}).\n${cut(said, "")}\nThe ones before it were applied, in the window.`, preview: `stopped at ${batch[bad]?.command}` };
            }
            if (!hand.bytes) return { ok: false, summary: `The window did the edit but could not send the picture back: ${hand.error ?? "no picture"}.\n${cut(said, "")}` };
            return { ok: true, summary: `Applied ${batch.length} command${batch.length === 1 ? "" : "s"} by hand in the window, where the person watched.\n${cut(said, "")}\nCall photo_look to see the result.`, preview: batch.length === 1 ? batch[0].command : `${batch.length} commands` };
          }
          const r = await serve(session, [
            { method: "doc.open", params: { path: WORK } },
            { method: "batch", params: { steps: batch, stopOnError: true } },
            { method: "doc.save", params: { path: WORK } },
            { method: "doc.inspect" },
          ]);
          first(r, "Could not open the picture");
          const done = first(r.slice(1), "The edit did not run") as { completed?: number; failed?: number; results?: any[] };
          const results = Array.isArray(done?.results) ? done.results : [];
          const bad = results.findIndex((x: any) => x && (x.ok === false || x.error));
          const said = results.map((x: any, i: number) => `${i + 1}. ${batch[i]?.command ?? "?"}: ${x?.error ? `FAILED -- ${x.error}` : x?.result !== undefined ? JSON.stringify(x.result).slice(0, 300) : "done"}`).join("\n");
          // Whatever ran is kept (the engine stops at the first failure), so the window shows it and the agent can go on from there.
          const saved = r[2]?.ok === true;
          if (saved) {
            const doc = r[3]?.ok ? (r[3].result as Inspected) : undefined;
            mine.by = "agent";
            setOpen(session, true);
            noteChange(session, "agent", doc, { who: "agent", name: "agent_edit", line: applied });
          }
          if (bad >= 0) {
            return { ok: false, summary: `Stopped at command ${bad + 1} (${batch[bad]?.command}).\n${cut(said, "")}\nThe ones before it were applied.`, preview: `stopped at ${batch[bad]?.command}` };
          }
          return { ok: true, summary: `Applied ${batch.length} command${batch.length === 1 ? "" : "s"}.\n${cut(said, "")}\nCall photo_look to see the result.`, preview: batch.length === 1 ? batch[0].command : `${batch.length} commands` };
        }

        case "photo_export": {
          if (!hasPicture(session)) return { ok: false, summary: none };
          const format = String(args.format ?? "png").toLowerCase().replace(/^\./, "");
          const kind = FORMATS[format];
          if (!kind) return { ok: false, summary: `Formats: ${[...new Set(Object.values(FORMATS).map((f) => f.ext))].join(", ")}.` };
          const out = `out-${crypto.randomBytes(4).toString("hex")}.${kind.ext}`;
          const quality = Number(args.quality);
          try {
            const r = await serve(session, [
              { method: "doc.open", params: { path: WORK } },
              { method: "doc.save", params: { path: out, ...(Number.isFinite(quality) && quality >= 1 && quality <= 100 ? { quality: Math.round(quality) } : {}) } },
            ]);
            first(r, "Could not open the picture");
            first(r.slice(1), "Could not export");
            const data = fs.readFileSync(path.join(folder(session), out));
            const art = saveArtifact({
              origin: "agent",
              app: "photo",
              name: exportName(args.name, kind.ext, "photo"),
              data,
              mime: kind.mime,
              session,
              note: `Exported from Autora Photo as ${kind.ext.toUpperCase()}`,
            });
            hooks.showFile?.({ id: art.id, name: art.name, mime: art.mime, size: art.size });
            return { ok: true, summary: `Exported the picture as ${art.name} (${data.length} bytes), saved as artifact ${art.id}. The person can download it from the thread.`, preview: art.name };
          } finally {
            fs.rmSync(path.join(folder(session), out), { force: true });
          }
        }

        default:
          return { ok: false, summary: `Unknown tool "${tool}".` };
      }
    });
  } catch (err) {
    const message = err instanceof FileRefError || err instanceof Error ? err.message : String(err);
    return { ok: false, summary: `Autora Photo could not do that: ${message}`, preview: tool.slice(6) };
  }
}

/** For the start of a turn: the layer the person is working on, while that is fresh. Null when none or the window is shut. */
export function photoPickNote(session: string): string | null {
  if (!validSession(session)) return null;
  const e = entries.get(session);
  const picked = e?.open ? pickText(e.pick) : null;
  return picked ? `The person is working on this layer of the picture in the Photo window: ${picked}. When they say "this", they mean that.` : null;
}

/** The picture for the capability briefing. */
export function photoBriefing(on: boolean): string {
  if (!on) {
    return "- Autora Photo (the photo editing window): switched off on the Tools page. Do not try to edit photos with it, and if asked, say it is off.";
  }
  return (
    "- Autora Photo (the photo editing window, PhotoCraft): available. Tools: photo_open, photo_look, photo_info, photo_edit, photo_commands, " +
    "photo_export. Layers, masks, adjustments, filters, type, brushes, PSD files. Look with photo_look after a change, before you say it is " +
    "done. The person edits the same picture by hand: photo_info again before relying on what you saw. Look, colour and composition are " +
    "theirs: suggest and ask; the technical work is yours."
  );
}

// ------------------------------------------------------------------ routes --

const rawDoc = express.raw({ type: "*/*", limit: MAX_DOC });

/** The window's side of the wire: its state, its picture, and opening and putting it away. */
export function photoRoutes(app: Express, opts: {
  exists: (session: string) => boolean;
  incognito: (session: string) => boolean;
  off: () => boolean;
  /** Send a message to the chat's open pages (not kept in its log). */
  push?: (session: string, message: Record<string, unknown>) => void;
  /** Whether Visible work is on: then the agent's edits are done in the window, by hand. */
  visible?: () => boolean;
}) {
  if (opts.push) hs.setPush(opts.push);
  if (opts.visible) visible = opts.visible;
  const known = (req: Request, res: Response): string | null => {
    const id = String(req.params.session);
    if (!validSession(id) || !opts.exists(id)) {
      res.status(404).json({ error: "No such session." });
      return null;
    }
    if (!hasEditor()) {
      res.status(503).json({ error: "Autora Photo is not built into this server." });
      return null;
    }
    return id;
  };

  app.get("/api/photo/:session", (req, res) => {
    const id = known(req, res);
    if (id) res.json(photoState(id));
  });

  /* The picture, as the editor opens it. */
  app.get("/api/photo/:session/doc", (req, res) => {
    const id = known(req, res);
    if (!id) return;
    const file = workFile(id);
    if (!fs.existsSync(file)) return res.status(404).json({ error: "There is no picture yet." });
    const e = entryFor(id);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("X-Photo-Rev", String(e.rev));
    res.send(fs.readFileSync(file));
  });

  /* What the person did in the editor. It must be a PhotoCraft file (the command line opens it, so a malformed one is
     refused here rather than kept), and it replaces the picture. */
  app.put("/api/photo/:session/doc", rawDoc, async (req, res) => {
    const id = known(req, res);
    if (!id) return;
    if (opts.off()) return res.status(403).json({ error: "Autora Photo is switched off on the Tools page." });
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || body.length === 0) return res.status(400).json({ error: "That is not a picture." });
    if (!cliFile()) {
      // No command line to check it with: keep it as the editor made it.
      fs.mkdirSync(folder(id), { recursive: true, mode: 0o700 });
      stage(id);
      fs.writeFileSync(workFile(id), body, { mode: 0o600 });
      noteChange(id, "person", undefined, { who: "person", name: "person_edit", line: "changed the picture" });
      return res.json({ rev: entryFor(id).rev });
    }
    try {
      await inLine(id, async () => {
        fs.mkdirSync(folder(id), { recursive: true, mode: 0o700 });
        const incoming = `put-${crypto.randomBytes(4).toString("hex")}.pcraft`;
        fs.writeFileSync(path.join(folder(id), incoming), body, { mode: 0o600 });
        try {
          const r = await serve(id, [{ method: "doc.open", params: { path: incoming } }, { method: "doc.inspect" }], { timeoutMs: 60_000 });
          first(r, "That is not a PhotoCraft picture");
          const doc = first(r.slice(1), "Could not read the picture") as Inspected;
          stage(id);
          fs.renameSync(path.join(folder(id), incoming), workFile(id));
          // Stays "person" until the agent's next tool call says otherwise: that is who made the latest change.
          noteChange(id, "person", doc, { who: "person", name: "person_edit", line: describePhotoChange(entryFor(id).reading, doc).join("; ") });
        } finally {
          fs.rmSync(path.join(folder(id), incoming), { force: true });
        }
      });
      res.json({ rev: entryFor(id).rev });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /* The person pressed Save: the picture as it is now, kept in Artifacts as a PNG (the layered file stays the
     window's). The agent is not asked and not woken. */
  app.post("/api/photo/:session/keep", async (req, res) => {
    const id = known(req, res);
    if (!id) return;
    if (opts.off()) return res.status(403).json({ error: "Autora Photo is switched off on the Tools page." });
    if (!fs.existsSync(workFile(id))) return res.status(404).json({ error: "There is no picture yet." });
    if (!cliFile()) return res.status(503).json({ error: "Autora Photo's command line is not built into this server." });
    const out = `keep-${crypto.randomBytes(4).toString("hex")}.png`;
    try {
      const data = await inLine(id, async () => {
        const r = await serve(id, [{ method: "doc.open", params: { path: WORK } }, { method: "doc.save", params: { path: out } }], { timeoutMs: 60_000 });
        first(r, "Could not open the picture");
        first(r.slice(1), "Could not save it as a PNG");
        return fs.readFileSync(path.join(folder(id), out));
      });
      const art = keepCopy({ session: id, title: chatTitle(id), fallback: "Picture", ext: "png", data, mime: "image/png", note: "Saved from Autora Photo", app: "photo" });
      res.json({ artifact: art.id, name: art.name });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      fs.rmSync(path.join(folder(id), out), { force: true });
    }
  });

  /* The agent's edit, by hand: the first window to ask does it. */
  // The log of what was done to the picture, by whom (commandlog.ts); and the person going back to before any command.
  app.get("/api/photo/:session/commands", (req, res) => {
    const id = known(req, res);
    if (id) res.json({ commands: photoLog(id) });
  });

  app.post("/api/photo/:session/commands/revert", express.json({ limit: "1kb" }), async (req, res) => {
    const id = known(req, res);
    if (!id) return;
    if (opts.off()) return res.status(403).json({ error: "Autora Photo is switched off on the Tools page." });
    const n = Number(req.body?.n);
    if (!Number.isInteger(n)) return res.status(400).json({ error: "n must be a command number from the log." });
    try {
      const problem = await inLine(id, () => revertPhotoCommandHeld(id, n, "person"));
      if (problem) return res.status(404).json({ error: problem });
      res.json({ ok: true, rev: entryFor(id).rev });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // The layer the person is on in the editor. Not a change to the picture: told to the agent in its next briefing.
  app.post("/api/photo/:session/pick", express.json({ limit: "2kb" }), (req, res) => {
    const id = known(req, res);
    if (!id) return;
    const e = entryFor(id);
    if (e.open) e.pick = rememberPick(req.body?.text);
    res.json({ ok: true });
  });

  app.post("/api/photo/:session/hand/claim", (req, res) => {
    const id = known(req, res);
    if (!id) return;
    res.json({ won: hs.claim(id, String(req.query.id ?? "")).won });
  });

  /* ...and its answer: the picture as the body, what each command did in X-Photo-Hand. */
  app.post("/api/photo/:session/hand/reply", rawDoc, (req, res) => {
    const id = known(req, res);
    if (!id) return;
    let said: { results?: unknown; error?: unknown } = {};
    try {
      said = JSON.parse(decodeURIComponent(String(req.get("X-Photo-Hand") ?? "")));
    } catch {
      // nothing said
    }
    const results = (Array.isArray(said.results) ? said.results : []).slice(0, 200).map((r: any): HandResult => ({
      command: typeof r?.command === "string" ? r.command.slice(0, 120) : undefined,
      ok: r?.ok !== false,
      error: typeof r?.error === "string" ? r.error.slice(0, 600) : undefined,
      how: r?.how === "direct" ? "direct" : "ui",
    }));
    const body = req.body as Buffer;
    const handed: Handed = { results, bytes: Buffer.isBuffer(body) && body.length > 0 ? body : null, error: typeof said.error === "string" ? said.error.slice(0, 600) : undefined };
    if (!hs.reply(id, String(req.query.id ?? ""), handed)) return res.status(404).json({ error: "No such edit." });
    res.json({ ok: true });
  });

  /* The person opens it from the toolbox: the editor, with whatever picture the chat has. */
  app.post("/api/photo/:session/open", (req, res) => {
    const id = known(req, res);
    if (!id) return;
    if (opts.off()) return res.status(403).json({ error: "Autora Photo is switched off on the Tools page." });
    if (opts.incognito(id)) return res.status(409).json({ error: "An incognito chat keeps nothing, so it has no photo window." });
    setOpen(id, true);
    res.json({ ...photoState(id), name: "Your picture" });
  });

  app.post("/api/photo/:session/close", (req, res) => {
    const id = known(req, res);
    if (!id) return;
    setOpen(id, false);
    res.json(photoState(id));
  });
}

/**
 * The editor's page, served to the frame that holds it. It is PhotoCraft's own code with Autora's overlay, in a frame of
 * this origin (the window talks to it by postMessage only), so it may be framed by this app and by nothing else, and it
 * may start WebAssembly but reach nothing outside this origin.
 */
export function servePhoto(app: Express, dist: string): void {
  /* trunk puts the loader that starts the WebAssembly inline in index.html. It is allowed by its hash, read from the
     built page, rather than by 'unsafe-inline': nothing else may run inline. */
  const page = path.join(dist, "photo", "web", "index.html");
  const inline = (): string[] => {
    try {
      const html = fs.readFileSync(page, "utf8");
      return [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => `'sha256-${crypto.createHash("sha256").update(m[1]).digest("base64")}'`);
    } catch {
      return [];
    }
  };
  let allowed: { stamp: number; hashes: string[] } = { stamp: -1, hashes: [] };
  const hashes = (): string[] => {
    const stamp = fs.statSync(page, { throwIfNoEntry: false })?.mtimeMs ?? 0;
    if (stamp !== allowed.stamp) allowed = { stamp, hashes: inline() };
    return allowed.hashes;
  };
  app.use(
    "/autora-photo",
    (_req, res, next) => {
      res.setHeader(
        "Content-Security-Policy",
        [
          "default-src 'self'",
          `script-src 'self' 'wasm-unsafe-eval' ${hashes().join(" ")}`.trim(),
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data: blob:",
          "font-src 'self' data:",
          "worker-src 'self' blob:",
          "connect-src 'self' data: blob:",
          "frame-ancestors 'self'",
        ].join("; "),
      );
      res.setHeader("X-Content-Type-Options", "nosniff");
      next();
    },
    ...staticDir(path.join(dist, "photo", "web"), { fallthrough: false }),
  );
}
