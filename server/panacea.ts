/**
 * Panacea: the canvas window, where the controls come to the work.
 *
 * One canvas per chat (src/lib/panacea/canvas.ts). It lives here, and:
 *
 *   - the agent's `panacea_*` tools change it: surfaces in, panels placed from the library or composed from atoms (each
 *     checked against the rulebook, src/lib/panacea/recipe.ts), values set, panels moved and put away, bespoke pieces
 *     drafted with the person; every change is announced to the window, which loads it;
 *   - the person works in the window (src/components/PanaceaWindow.tsx) and what they change is put back here
 *     (`PUT /api/panacea/:session/doc`), refused (409) when it was based on a canvas the agent has changed since;
 *   - what the person does is told here as it happens (`/activity`): it goes into the next turn's note, it can wake a
 *     small model that offers a panel as a ghost (`suggest`), and it teaches the profile (src/lib/panacea/profile.ts).
 *
 * The library is the built-in recipes (src/lib/panacea/library.ts) and what has been composed and used since, kept
 * once per install and deduplicated by shape; the profile is kept once per install too.
 *
 * With Visible work on and the window up, an agent's change is done there by its hand (src/lib/panacea/handsteps.ts):
 * the window's own picker, sliders and switches, while the call waits.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express, { type Express, type Request, type Response } from "express";
import { unzipSync, strFromU8 } from "fflate";
import type { Value } from "../src/lib/panacea/atoms";
import {
  contextOf, describeCanvas, fade, MAX_PANELS, newCanvas, normalizeCanvas, refocus, removeSurface, restore,
  setValue, snap, uid, valueProblem, PANEL_MAX_W, PANEL_MIN_W, type Canvas, type Panel, type Surface,
} from "../src/lib/panacea/canvas";
import { panaceaSteps, stepWords } from "../src/lib/panacea/handsteps";
import { BUILTINS, DOMAINS, libraryIndex, searchLibrary, type Domain, type Recipe } from "../src/lib/panacea/library";
import { normalizeProfile, noteDismiss, noteSide, noteUse, preferredSide, profileWords, quieted, sideOf, usageKey, type Profile } from "../src/lib/panacea/profile";
import { checkTree, fingerprint, generalize, treeWords, type Node } from "../src/lib/panacea/recipe";
import { addSurfaceTo, placeComposed, placeRecipe, suggestFor, type SurfaceInput } from "../src/lib/panacea/rules";
import { filteredRows, splitDelimited, tableCsv, tableFrom, type Table } from "../src/lib/panacea/surfaces";
import { MAX_ARTIFACT_BYTES, keepCopy, saveArtifact } from "./artifacts";
import { chatTitle } from "./folders";
import { readFileRef } from "./fileref";
import { stateDir } from "./state";
import { readDoc, saveDoc } from "./store";

// ------------------------------------------------------------------ state --

interface PanaceaState {
  open: boolean;
  since?: number;
  rev?: number;
  by?: "agent" | "person";
  name?: string;
  panels?: number;
  surfaces?: number;
  quiet?: number;
}

/** Something the person did on the canvas, for the next turn and for the suggester. */
interface Act {
  at: number;
  text: string;
}

interface Entry {
  canvas: Canvas;
  open: boolean;
  since: number;
  rev: number;
  by: "agent" | "person";
  ready: boolean;
  quiet?: number;
  acts: Act[];
  /** When a suggestion was last made, and how many this hour. */
  suggested: number[];
  suggestTimer?: NodeJS.Timeout;
}

interface Saved {
  canvas: Canvas;
  open: boolean;
  since: number;
}

const entries = new Map<string, Entry>();
const listeners = new Set<(session: string) => void>();
let pushed: (session: string, message: Record<string, unknown>) => void = () => undefined;
let visible: () => boolean = () => false;
/** Whether Visible work is on (server.ts says). */
export function panaceaVisible(fn: () => boolean) {
  visible = fn;
}

const validSession = (id: string) => /^[A-Za-z0-9_-]{1,80}$/.test(id);
const savedName = (session: string) => `panacea-${session}`;
const MAX_ACTS = 30;

function entryFor(session: string): Entry {
  let entry = entries.get(session);
  if (!entry) {
    const saved = validSession(session) ? readDoc<Saved>(savedName(session)) : null;
    entry = {
      canvas: (saved && normalizeCanvas(saved.canvas)) || newCanvas(chatTitle(session) ?? "Canvas"),
      open: Boolean(saved?.open),
      since: saved?.since ?? 0,
      rev: Date.now(),
      by: "agent",
      ready: false,
      acts: [],
      suggested: [],
    };
    entries.set(session, entry);
  }
  return entry;
}

function persist(session: string, e: Entry) {
  if (!validSession(session)) return;
  saveDoc(savedName(session), () => ({ canvas: e.canvas, open: e.open, since: e.since }) satisfies Saved);
}

function changed(session: string) {
  for (const fn of listeners) fn(session);
}

export function panaceaState(session: string): PanaceaState {
  if (!validSession(session)) return { open: false };
  const e = entryFor(session);
  if (!e.open) return { open: false };
  return {
    open: true, since: e.since, rev: e.rev, by: e.by, name: e.canvas.name, panels: e.canvas.panels.length, surfaces: e.canvas.surfaces.length,
    ...(e.quiet === e.rev ? { quiet: e.rev } : {}),
  };
}

export function onPanaceaChange(fn: (session: string) => void) {
  listeners.add(fn);
}

function setOpen(session: string, open: boolean) {
  const e = entryFor(session);
  if (e.open === open) return;
  e.open = open;
  e.ready = false;
  if (open) e.since = Date.now();
  else rejectAll(session, "The Panacea window was closed.");
  persist(session, e);
  changed(session);
}

function commit(session: string, e: Entry, next: Canvas, who: "agent" | "person") {
  e.canvas = next;
  e.rev++;
  e.by = who;
  persist(session, e);
  changed(session);
}

/** The chat is gone: let go of its canvas, and of the file it was kept in. */
export function dropPanacea(session: string) {
  rejectAll(session, "The chat was closed.");
  const e = entries.get(session);
  if (e?.suggestTimer) clearTimeout(e.suggestTimer);
  entries.delete(session);
  if (!validSession(session)) return;
  fs.rmSync(path.join(stateDir(), `${savedName(session)}.json`), { force: true });
}

// ---------------------------------------------------------------- library --

interface LibraryStore {
  recipes: Recipe[];
}

const LIBRARY = "panacea-library";
const PROFILE = "panacea-profile";
let library: Recipe[] | null = null;
let profile: Profile | null = null;
/** A composed recipe nobody used is forgotten after this long. */
const UNUSED_MS = 7 * 24 * 3600_000;
const MAX_LEARNED = 400;

function learned(): Recipe[] {
  if (!library) {
    const saved = readDoc<LibraryStore>(LIBRARY);
    const now = Date.now();
    library = (saved?.recipes ?? [])
      .filter((r) => r && typeof r.id === "string" && r.tree && (r.uses > 0 || now - (r.at ?? 0) < UNUSED_MS))
      .map((r) => ({ ...r, domain: (DOMAINS as readonly string[]).includes(r.domain) ? r.domain : "general" }));
  }
  return library;
}

function saveLibrary() {
  const list = learned();
  saveDoc(LIBRARY, () => ({ recipes: list }) satisfies LibraryStore);
}

function profileNow(): Profile {
  if (!profile) profile = normalizeProfile(readDoc<Profile>(PROFILE));
  return profile;
}

function saveProfile() {
  const p = profileNow();
  saveDoc(PROFILE, () => p);
}

/** Every recipe: the built-ins, with their use counts, and the ones learned since. */
function allRecipes(): Recipe[] {
  const p = profileNow();
  return [...BUILTINS.map((r) => ({ ...r, uses: p.uses[`recipe:${r.id}`] ?? 0 })), ...learned()];
}

const findRecipe = (id: string): Recipe | undefined => allRecipes().find((r) => r.id === id);

/**
 * A panel's tree kept in the library by its shape: an existing entry with the same shape is the same recipe (its use
 * counted), else a new one. Returns its id. `used` is false for one the agent has only placed: it is kept so the
 * hand can summon it, and forgotten in a week if nobody uses it.
 */
function learn(tree: Node, meta: { name: string; about: string; domain: Domain; origin: "composed" | "bespoke"; w: number }, kinds: Record<string, "image" | "data">, used: boolean): string {
  const general = generalize(tree, kinds);
  const fp = fingerprint(general);
  const builtin = BUILTINS.find((r) => fingerprint(r.tree) === fp);
  if (builtin) {
    if (used) { noteUse(profileNow(), `recipe:${builtin.id}`); saveProfile(); }
    return builtin.id;
  }
  const list = learned();
  const have = list.find((r) => r.fp === fp);
  if (have) {
    if (used) have.uses += 1;
    saveLibrary();
    return have.id;
  }
  const id = `${meta.origin === "bespoke" ? "bespoke" : "made"}.${crypto.randomBytes(4).toString("hex")}`;
  const words = `${meta.name} ${meta.about}`.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2).slice(0, 12);
  list.push({ id, name: meta.name.slice(0, 60), domain: meta.domain, about: meta.about.slice(0, 160), tags: words, tree: general, w: meta.w, origin: meta.origin, uses: used ? 1 : 0, fp, at: Date.now() });
  // Full: the least used of the ones nobody has touched go first.
  if (list.length > MAX_LEARNED) {
    list.sort((a, b) => b.uses - a.uses || (b.at ?? 0) - (a.at ?? 0));
    list.length = MAX_LEARNED;
  }
  saveLibrary();
  return id;
}

const kindsOf = (canvas: Canvas): Record<string, "image" | "data"> => Object.fromEntries(canvas.surfaces.map((s) => [s.id, s.kind]));

/** The kind of work a panel on this canvas is about, for filing a learned recipe. */
function domainFor(canvas: Canvas, panel: Panel): Domain {
  const s = canvas.surfaces.find((x) => x.id === panel.context);
  if (s) return s.kind === "image" ? "photo" : "data";
  const bind = JSON.stringify(panel.tree);
  const prefix: Array<[RegExp, Domain]> = [[/"doc\./, "document"], [/"music\./, "music"], [/"video\./, "video"], [/"model\./, "3d"], [/"game\./, "game"], [/"ui\./, "design"]];
  return prefix.find(([re]) => re.test(bind))?.[1] ?? "general";
}

// ----------------------------------------------------------------- telling --

/** What the agent is told at the start of a turn when the window is open. */
export function panaceaTurnNote(session: string): string | null {
  if (!validSession(session)) return null;
  const e = entries.get(session);
  if (!e?.open) return null;
  const recent = e.acts.filter((a) => Date.now() - a.at < 15 * 60_000).slice(-10).map((a) => a.text);
  const learnedWords = profileWords(profileNow());
  return [
    `The Panacea window is open. ${describeCanvas(e.canvas)}`,
    recent.length ? `What the person did on it lately: ${recent.join("; ")}.` : "",
    learnedWords ?? "",
    "panacea_look shows the panels' trees and the library; the person changes it by hand too, so look before relying on an earlier look.",
  ].filter(Boolean).join("\n");
}

/** The capability line for the system prompt: paid for on every turn, so short. */
export function panaceaBriefing(on: boolean): string {
  if (!on) return "- Panacea (canvas window): switched off on the Tools page; if asked, say so.";
  return "- Panacea (canvas window): panacea_* tools (tools_enable panacea). Controls appear for the work and go when it moves on; compose from the library's atoms only.";
}

function act(session: string, e: Entry, text: string) {
  e.acts.push({ at: Date.now(), text: text.slice(0, 200) });
  if (e.acts.length > MAX_ACTS) e.acts.splice(0, e.acts.length - MAX_ACTS);
  touch(session, text);
}

let touch: (session: string, text: string) => void = () => undefined;
/** Told what the person did, so presence and the companion hear it (server.ts). */
export function onPanaceaTouch(fn: (session: string, text: string) => void) {
  touch = fn;
}

// --------------------------------------------------------------- commands --

type Pending = { session: string; resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; claimed: boolean };
const pending = new Map<string, Pending>();

function rejectAll(session: string, why: string) {
  for (const [id, p] of pending) {
    if (p.session !== session) continue;
    clearTimeout(p.timer);
    pending.delete(id);
    p.reject(new Error(why));
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Ask the open window to do something only a browser can (render a picture, do a step by hand), and wait. */
async function command(session: string, name: string, args: Record<string, unknown> = {}, timeoutMs = 60_000, claimMs?: number): Promise<unknown> {
  setOpen(session, true);
  const e = entryFor(session);
  for (let waited = 0; !e.ready && waited < 20_000; waited += 150) await sleep(150);
  if (!e.ready) throw new Error("The Panacea window did not start. It opens in the browser tab for this chat; if no tab is open, open Autora there and try again.");
  const id = crypto.randomBytes(6).toString("hex");
  return await new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`The Panacea window did not answer ${name} in ${Math.round(timeoutMs / 1000)} seconds.`));
    }, timeoutMs);
    const entry: Pending = { session, resolve, reject, timer, claimed: false };
    pending.set(id, entry);
    if (claimMs) {
      setTimeout(() => {
        if (entry.claimed || !pending.has(id)) return;
        clearTimeout(timer);
        pending.delete(id);
        entry.reject(new Error("unclaimed"));
      }, claimMs);
    }
    const send = () => pushed(session, { type: "panacea.command", session, id, name, args });
    send();
    const again = setInterval(() => {
      if (entry.claimed || !pending.has(id)) clearInterval(again);
      else send();
    }, 1500);
    const settle = entry.resolve;
    entry.resolve = (v) => { clearInterval(again); settle(v); };
    const refuse = entry.reject;
    entry.reject = (err) => { clearInterval(again); refuse(err); };
  });
}

/** With Visible work on and the window up, the change is done there by the agent's hand while this waits. */
async function byHand(session: string, e: Entry, next: Canvas): Promise<string | null> {
  if (!visible() || !e.open || !e.ready) return null;
  const plan = panaceaSteps(e.canvas, next);
  if (!plan.steps.length) return null;
  type Reply = { results?: Array<{ i: number; ok: boolean; error?: string }> } | null;
  let reply: Reply;
  try {
    reply = (await command(session, "hand", { steps: plan.steps }, 30_000 + plan.steps.length * 12_000, 4000)) as Reply;
  } catch {
    return null;
  }
  const results = reply?.results ?? [];
  const did = results.filter((r) => r.ok).map((r) => stepWords(plan.steps[r.i]!));
  const not = results.filter((r) => !r.ok).map((r) => `${stepWords(plan.steps[r.i]!)} (${r.error ?? "not done"})`);
  if (!did.length) return null;
  return `Done by hand in the Panacea window, where the person watched: ${did.join("; ")}.` +
    (not.length || plan.skipped ? ` Not by hand (in the finished canvas, which is in the window now): ${[...not, ...(plan.skipped ? [`${plan.skipped} more change${plan.skipped === 1 ? "" : "s"} with no control on screen`] : [])].join("; ")}.` : "");
}

// ------------------------------------------------------------- suggesting --

/** At least this long between two suggestions the model makes unasked, and no more than this many an hour. */
const SUGGEST_GAP_MS = 90_000;
const SUGGEST_PER_HOUR = 10;
const SUGGEST_SETTLE_MS = 6_000;

interface SuggestHooks {
  /** A small, unwatched model call (server.ts `backgroundCall`). */
  ask: (session: string, system: string, prompt: string) => Promise<string>;
  /** Whether it may: the companion is on, the chat is not busy, somebody is watching. */
  allowed: (session: string) => boolean;
}
let suggester: SuggestHooks | null = null;
export function panaceaSuggester(hooks: SuggestHooks) {
  suggester = hooks;
}

const SUGGEST_SYSTEM = [
  "You watch a person working on a canvas in Autora's Panacea window and may offer ONE panel that would help with what they are doing right now.",
  "You can only offer a recipe from the candidates listed, by its id. Offer nothing when what they have is enough, when they are busy with something a panel will not help, or when a similar panel is already on the canvas.",
  "Answer with one line of JSON: {\"recipe\": \"<id>\", \"why\": \"<one short sentence, to the person, saying what it is for now>\"} -- or the single word SKIP.",
].join("\n");

function scheduleSuggest(session: string, e: Entry) {
  if (!suggester) return;
  if (e.suggestTimer) clearTimeout(e.suggestTimer);
  e.suggestTimer = setTimeout(() => void suggestNow(session), SUGGEST_SETTLE_MS);
}

async function suggestNow(session: string): Promise<void> {
  const e = entries.get(session);
  if (!e?.open || !suggester || !suggester.allowed(session)) return;
  const now = Date.now();
  e.suggested = e.suggested.filter((t) => now - t < 3600_000);
  if (e.suggested.length >= SUGGEST_PER_HOUR || (e.suggested.at(-1) ?? 0) > now - SUGGEST_GAP_MS) return;
  if (e.canvas.panels.some((p) => p.state === "ghost")) return;
  const recent = e.acts.filter((a) => now - a.at < 120_000).map((a) => a.text);
  if (!recent.length) return;
  e.suggested.push(now);
  const focus = e.canvas.surfaces.find((s) => s.id === e.canvas.focus);
  const domain = focus ? (focus.kind === "image" ? "photo" : "data") : null;
  const p = profileNow();
  const onCanvas = new Set(e.canvas.panels.map((x) => x.recipe).filter(Boolean));
  const pool = allRecipes().filter((r) => !onCanvas.has(r.id) && !quieted(p, r.id) && (r.origin === "builtin" || r.uses > 0));
  const candidates = [...new Map([...searchLibrary(pool, recent.join(" "), domain, 10), ...searchLibrary(pool, "", domain, 8)].map((r) => [r.id, r])).values()].slice(0, 14);
  if (!candidates.length) return;
  const prompt = [
    describeCanvas(e.canvas),
    `What they did in the last two minutes: ${recent.join("; ")}.`,
    profileWords(p) ?? "",
    `Candidates:\n${candidates.map((r) => `- ${r.id}: ${r.name}, ${r.about}`).join("\n")}`,
  ].filter(Boolean).join("\n\n");
  let raw = "";
  try {
    raw = await suggester.ask(session, SUGGEST_SYSTEM, prompt);
  } catch {
    return;
  }
  const json = /\{[\s\S]*\}/.exec(raw)?.[0];
  if (!json) return;
  let pick: { recipe?: unknown; why?: unknown };
  try {
    pick = JSON.parse(json) as { recipe?: unknown; why?: unknown };
  } catch {
    return;
  }
  const recipe = candidates.find((r) => r.id === pick.recipe);
  if (!recipe || !e.open || e.canvas.panels.some((x) => x.state === "ghost")) return;
  const next = structuredClone(e.canvas);
  const placed = placeRecipe(next, recipe, { near: next.focus, state: "ghost", why: typeof pick.why === "string" ? pick.why.slice(0, 200) : `Offered: ${recipe.about}.`, by: "agent", side: preferredSide(p) });
  if ("error" in placed) return;
  commit(session, e, next, "agent");
}

// ------------------------------------------------------------------ tools --

interface PanaceaHooks {
  cwd: string;
  showFile?: (file: { id: string; name: string; mime: string; size: number }) => void;
}

interface Outcome {
  ok: boolean;
  summary: string;
  preview?: string;
}

class Refuse extends Error {}
const refuse = (message: string): never => { throw new Refuse(message); };

/** The pixel size of a PNG, JPEG, GIF or WebP from its first bytes; null when it cannot tell. */
function imageSize(data: Buffer): { w: number; h: number } | null {
  if (data.length > 24 && data.readUInt32BE(0) === 0x89504e47) return { w: data.readUInt32BE(16), h: data.readUInt32BE(20) };
  if (data.length > 10 && data.toString("ascii", 0, 3) === "GIF") return { w: data.readUInt16LE(6), h: data.readUInt16LE(8) };
  if (data.length > 30 && data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP") {
    const chunk = data.toString("ascii", 12, 16);
    if (chunk === "VP8X") return { w: 1 + data.readUIntLE(24, 3), h: 1 + data.readUIntLE(27, 3) };
    if (chunk === "VP8 ") return { w: data.readUInt16LE(26) & 0x3fff, h: data.readUInt16LE(28) & 0x3fff };
    if (chunk === "VP8L") { const b = data.readUInt32LE(21); return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1 }; }
  }
  if (data.length > 4 && data[0] === 0xff && data[1] === 0xd8) {
    let i = 2;
    while (i + 9 < data.length) {
      if (data[i] !== 0xff) { i++; continue; }
      const marker = data[i + 1]!;
      const len = data.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { w: data.readUInt16BE(i + 7), h: data.readUInt16BE(i + 5) };
      i += 2 + len;
    }
  }
  return null;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;
const TABLE_EXT = /\.(csv|tsv|txt|xlsx)$/i;

/** The first sheet of an .xlsx as rows of strings. */
function xlsxGrid(data: Buffer): string[][] | null {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(new Uint8Array(data), { filter: (f) => f.name === "xl/sharedStrings.xml" || /^xl\/worksheets\/sheet1\.xml$/.test(f.name) });
  } catch {
    return null;
  }
  const sheet = files["xl/worksheets/sheet1.xml"];
  if (!sheet) return null;
  const unxml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  const shared: string[] = [];
  const sst = files["xl/sharedStrings.xml"];
  if (sst) for (const si of strFromU8(sst).matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(unxml([...si[1]!.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join("")));
  const grid: string[][] = [];
  const colOf = (ref: string) => [...ref.replace(/\d+/g, "")].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  for (const row of strFromU8(sheet).matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = [];
    for (const c of row[1]!.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = /\br="([A-Z]+\d+)"/.exec(c[1]!)?.[1];
      const type = /\bt="(\w+)"/.exec(c[1]!)?.[1];
      const v = c[2] ? /<v>([\s\S]*?)<\/v>/.exec(c[2])?.[1] : undefined;
      const inline = c[2] ? /<is>([\s\S]*?)<\/is>/.exec(c[2]) : null;
      const value = type === "s" && v !== undefined ? shared[Number(v)] ?? "" : inline ? unxml([...inline[1]!.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join("")) : v !== undefined ? unxml(v) : "";
      const at = ref ? colOf(ref) : cells.length;
      if (at < 0 || at > 200) continue;
      while (cells.length < at) cells.push("");
      cells[at] = value;
    }
    grid.push(cells);
    if (grid.length > 20_001) break;
  }
  return grid;
}

/** A table out of file bytes (CSV, TSV, XLSX) or pasted text. */
export function readTable(name: string, data: Buffer): Table | null {
  const grid = /\.xlsx$/i.test(name) ? xlsxGrid(data) : splitDelimited(data.toString("utf8").replace(/^\uFEFF/, ""));
  return grid ? tableFrom(grid) : null;
}

/** A surface for a file, with its starter panels, laid out the person's way. */
function addSurface(canvas: Canvas, input: SurfaceInput): { surface: Surface; panels: Panel[] } {
  const p = profileNow();
  const made = addSurfaceTo(canvas, input, findRecipe, { side: preferredSide(p), quiet: (id) => quieted(p, id) });
  if ("error" in made) refuse(made.error);
  return made as { surface: Surface; panels: Panel[] };
}

const numberOr = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

const needPanel = (c: Canvas, id: unknown): Panel => c.panels.find((p) => p.id === id) ?? refuse(`There is no panel "${String(id ?? "")}". ${c.panels.length ? `Panels: ${c.panels.map((p) => `${p.id} "${p.title}"`).join("; ")}.` : "There are none."}`);

/** The edit a changing tool call asks for, done to `c` (a copy). Returns what to tell the agent. */
function edit(session: string, name: string, c: Canvas, args: Record<string, any>, hooks: PanaceaHooks): { text: string; preview: string } {
  const p = profileNow();
  switch (name) {
    case "panacea_place": {
      if (c.panels.length >= MAX_PANELS) refuse(`The canvas has ${MAX_PANELS} panels; put some away first (panacea_arrange remove).`);
      const why = typeof args.why === "string" && args.why.trim() ? args.why.trim() : refuse("Say `why` the panel is here, in a sentence to the person: it is shown under the panel's ⓘ.");
      const near = typeof args.near === "string" ? args.near : null;
      const state = args.ghost === true ? "ghost" as const : "live" as const;
      const w = numberOr(args.w);
      const values: Record<string, Value> = {};
      if (args.values && typeof args.values === "object") for (const [k, v] of Object.entries(args.values as Record<string, unknown>)) values[k] = v as Value;
      let placed: Panel | { error: string };
      if (typeof args.recipe === "string" && args.recipe) {
        const recipe = findRecipe(args.recipe) ?? refuse(`There is no recipe "${args.recipe}". panacea_look with \`library\` finds them.`);
        if (state === "ghost" && quieted(p, recipe.id)) refuse(`The person has waved "${recipe.name}" away more than once; do not offer it unasked.`);
        placed = placeRecipe(c, recipe, { near, state, why, by: "agent", side: preferredSide(p), title: typeof args.title === "string" ? args.title : undefined, ...(w ? { w: Math.min(PANEL_MAX_W, Math.max(PANEL_MIN_W, snap(w))) } : {}) });
      } else if (args.tree !== undefined) {
        const title = typeof args.title === "string" && args.title.trim() ? args.title.trim() : refuse("A composed panel needs a `title`.");
        placed = placeComposed(c, args.tree, title, w ? Math.min(PANEL_MAX_W, Math.max(PANEL_MIN_W, snap(w))) : 288, { near, state, why, by: "agent", side: preferredSide(p) });
        if (!("error" in placed) && state === "live") {
          // Kept so the hand can summon it by name; it joins the library for real once the person uses it.
          placed.recipe = learn(placed.tree, { name: title, about: why, domain: domainFor(c, placed), origin: "composed", w: placed.w }, kindsOf(c), false);
        }
      } else return refuse("Give `recipe` (a library id) or `tree` (a panel composed of atoms).");
      if ("error" in placed) refuse(placed.error);
      const panel = placed as Panel;
      // Values it opens with: checked like any other.
      const problems: string[] = [];
      for (const [k, v] of Object.entries(values)) {
        const key = k.replace(/^@(image|data)\./, (_, kind: string) => `@${panel.context !== "general" ? panel.context : c.surfaces.find((s) => s.kind === kind)?.id ?? kind}.`);
        const bad = valueProblem(c, key, v);
        if (bad) problems.push(`${k}: ${bad}`);
        else setValue(c, key, v);
      }
      return {
        text: `Placed ${state === "ghost" ? "a ghost (the person takes it with a click, or it drifts away)" : "panel"} ${panel.id} "${panel.title}" at ${panel.x},${panel.y} on ${panel.context}.${problems.length ? ` Values not set: ${problems.join("; ")}.` : ""}\n${treeWords(panel.tree)}`,
        preview: panel.title,
      };
    }

    case "panacea_set": {
      const given = args.values && typeof args.values === "object" ? Object.entries(args.values as Record<string, unknown>) : [];
      if (!given.length) refuse("Pass `values`: {\"@img1.exposure\": 0.4, \"budget\": 1200}.");
      const done: string[] = [];
      const problems: string[] = [];
      for (const [k, v] of given.slice(0, 40)) {
        const bad = valueProblem(c, k, v);
        if (bad) problems.push(`${k}: ${bad}`);
        else { setValue(c, k, v as Value); done.push(`${k}=${JSON.stringify(v).slice(0, 40)}`); }
      }
      if (!done.length) refuse(`Nothing set. ${problems.join("; ")}`);
      return { text: `Set ${done.join(", ")}.${problems.length ? ` Not set: ${problems.join("; ")}.` : ""}`, preview: done[0]! };
    }

    case "panacea_arrange": {
      const done: string[] = [];
      if (typeof args.name === "string" && args.name.trim()) { c.name = args.name.trim().slice(0, 80); done.push(`named "${c.name}"`); }
      for (const m of Array.isArray(args.move) ? args.move : []) {
        const panel = needPanel(c, m?.id);
        const x = numberOr(m.x);
        const y = numberOr(m.y);
        const w = numberOr(m.w);
        if (x !== null) panel.x = snap(x);
        if (y !== null) panel.y = snap(y);
        if (w !== null) panel.w = Math.min(PANEL_MAX_W, Math.max(PANEL_MIN_W, snap(w)));
        done.push(`moved ${panel.id}`);
      }
      for (const id of Array.isArray(args.restore) ? args.restore : []) {
        const back = restore(c, String(id));
        done.push(back ? `brought back ${back.id}` : `nothing gone called ${String(id)}`);
      }
      for (const id of Array.isArray(args.accept) ? args.accept : []) {
        const panel = needPanel(c, id);
        if (panel.state === "ghost") { panel.state = "live"; done.push(`took ghost ${panel.id}`); }
      }
      if (Array.isArray(args.group) && args.group.length >= 2) {
        const g = uid("g");
        for (const id of args.group) needPanel(c, id).group = g;
        done.push(`grouped ${args.group.join(", ")}`);
      }
      for (const id of Array.isArray(args.ungroup) ? args.ungroup : []) { delete needPanel(c, id).group; done.push(`ungrouped ${String(id)}`); }
      if (args.titles && typeof args.titles === "object") {
        for (const [id, t] of Object.entries(args.titles as Record<string, unknown>)) {
          if (typeof t === "string" && t.trim()) { needPanel(c, id).title = t.trim().slice(0, 60); done.push(`retitled ${id}`); }
        }
      }
      // Put away last, so a call that also groups or retitles a panel it puts away still does those.
      for (const id of Array.isArray(args.remove) ? args.remove : []) {
        const panel = needPanel(c, id);
        if (panel.pinned) { done.push(`left ${panel.id} (the person pinned it)`); continue; }
        fade(c, panel.id);
        done.push(`put away ${panel.id} (the person can bring it back)`);
      }
      if (args.focus !== undefined) {
        const f = args.focus === null || args.focus === "" ? null : String(args.focus);
        if (f && !c.surfaces.some((s) => s.id === f)) refuse(`There is no surface "${f}".`);
        const r = refocus(c, f);
        done.push(`focus on ${f ?? "nothing"} (${r.dimmed} dimmed, ${r.gone} put away, ${r.back} back)`);
      }
      if (!done.length) refuse("Nothing to do: pass move, remove, restore, accept, group, ungroup, titles, focus or name.");
      return { text: `${done.join("; ")}.`, preview: done[0]! };
    }

    case "panacea_surface": {
      if (typeof args.remove === "string") {
        if (!removeSurface(c, args.remove)) refuse(`There is no surface "${args.remove}".`);
        return { text: `Removed ${args.remove}, with its panels.`, preview: "removed" };
      }
      const title = typeof args.title === "string" ? args.title : undefined;
      if (typeof args.csv === "string" && args.csv.trim()) {
        const table = readTable("pasted.csv", Buffer.from(args.csv, "utf8")) ?? refuse("That text is not a table: a header row and at least one row, separated by commas or tabs.");
        const { surface, panels } = addSurface(c, { kind: "data", name: `${title ?? "Table"}.csv`, title: title ?? "Table", table });
        return { text: `Added data surface ${surface.id} (${table.rows.length} rows; ${table.columns.map((x) => `${x.name} ${x.type}`).join(", ")}). Opened beside it: ${panels.map((x) => `${x.id} "${x.title}"${x.state === "ghost" ? " (ghost)" : ""}`).join(", ") || "nothing"}.`, preview: surface.title };
      }
      if (args.file === undefined) refuse("Give `file` (an artifact id or a path in the working folder), `csv` (the table as text), or `remove`.");
      const given = readFileRef(args.file, hooks.cwd, "the file", "panacea_surface");
      if (IMAGE_EXT.test(given.name)) {
        const art = given.artifact ?? saveArtifact({ origin: "agent", name: given.name, data: given.data, mime: `image/${/png$/i.test(given.name) ? "png" : /gif$/i.test(given.name) ? "gif" : /webp$/i.test(given.name) ? "webp" : "jpeg"}`, session, note: "Opened in Panacea" });
        const { surface, panels } = addSurface(c, { kind: "image", name: given.name, title, artifact: art.id, px: imageSize(given.data) });
        return { text: `Added image surface ${surface.id} "${surface.title}"${surface.px ? ` (${surface.px.w}x${surface.px.h})` : ""}. Opened beside it: ${panels.map((x) => `${x.id} "${x.title}"${x.state === "ghost" ? " (ghost)" : ""}`).join(", ") || "nothing"}.`, preview: surface.title };
      }
      if (TABLE_EXT.test(given.name)) {
        const table = readTable(given.name, given.data) ?? refuse(`${given.name} has no table in it (a header row and rows).`);
        const { surface, panels } = addSurface(c, { kind: "data", name: given.name, title, table, ...(given.artifact ? { artifact: given.artifact.id } : {}) });
        return { text: `Added data surface ${surface.id} (${table.rows.length} rows; ${table.columns.map((x) => `${x.name} ${x.type}`).join(", ")}). Opened beside it: ${panels.map((x) => `${x.id} "${x.title}"${x.state === "ghost" ? " (ghost)" : ""}`).join(", ") || "nothing"}.`, preview: surface.title };
      }
      return refuse(`${given.name} is not something Panacea works on yet: a photo (PNG, JPEG, GIF, WebP) or a table (CSV, TSV, XLSX). Its other work happens in the window made for it.`);
    }

    case "panacea_bespoke": {
      const action = String(args.action ?? "");
      if (action === "draft") {
        if (c.panels.length >= MAX_PANELS) refuse(`The canvas has ${MAX_PANELS} panels.`);
        const title = typeof args.title === "string" && args.title.trim() ? args.title.trim() : refuse("A draft needs a `title`.");
        const why = typeof args.why === "string" && args.why.trim() ? args.why.trim() : refuse("Say `why`: what the person asked for that the library could not do.");
        const tree = { atom: "bespoke", props: { html: args.html, binds: Array.isArray(args.binds) ? args.binds : [], height: numberOr(args.height) ?? 260 } };
        const placed = placeComposed(c, tree, title, Math.min(PANEL_MAX_W, Math.max(PANEL_MIN_W, snap(numberOr(args.w) ?? 352))), { near: typeof args.near === "string" ? args.near : null, state: "draft", why, by: "agent", side: preferredSide(p) });
        if ("error" in placed) refuse(placed.error);
        const panel = placed as Panel;
        return { text: `Drafted ${panel.id} "${title}" on the canvas (dashed: a draft). Ask the person what to change; revise with action revise; when they are happy they press Keep in library on it, or say so and you call action keep.`, preview: title };
      }
      const panel = needPanel(c, args.id);
      if (panel.tree.atom !== "bespoke") refuse(`${panel.id} is not a bespoke piece.`);
      if (action === "revise") {
        const props = { ...panel.tree.props };
        if (typeof args.html === "string") props.html = args.html;
        if (Array.isArray(args.binds)) props.binds = args.binds;
        if (numberOr(args.height) !== null) props.height = numberOr(args.height);
        const checked = checkTree({ atom: "bespoke", props }, contextOf(c));
        if (!checked.tree || checked.errors.length) refuse(checked.errors.join(" "));
        panel.tree = checked.tree!;
        if (typeof args.title === "string" && args.title.trim()) panel.title = args.title.trim().slice(0, 60);
        return { text: `Revised ${panel.id}.`, preview: panel.title };
      }
      if (action === "keep") {
        panel.state = "live";
        panel.recipe = learn(panel.tree, { name: panel.title, about: panel.why || panel.title, domain: domainFor(c, panel), origin: "bespoke", w: panel.w }, kindsOf(c), true);
        return { text: `Kept ${panel.id} "${panel.title}": it is in the library as ${panel.recipe}, to place again on any canvas.`, preview: panel.title };
      }
      if (action === "discard") {
        c.panels = c.panels.filter((x) => x.id !== panel.id);
        return { text: `Discarded the draft ${panel.id}.`, preview: "discarded" };
      }
      return refuse("action is draft, revise, keep or discard.");
    }
  }
  return refuse(`Unknown Panacea tool: ${name}`);
}

export async function runPanaceaTool(session: string, name: string, args: Record<string, any>, hooks: PanaceaHooks): Promise<Outcome> {
  if (!validSession(session)) return { ok: false, summary: "Panacea needs a chat to work in." };
  try {
    const e = entryFor(session);
    switch (name) {
      case "panacea_open": {
        if (typeof args.new === "string" && args.new.trim()) {
          const has = e.canvas.panels.length + e.canvas.surfaces.length > 0;
          if (has && args.replace !== true) return { ok: false, summary: `The canvas "${e.canvas.name}" has work on it, and a new one would clear it. If the person asked to start over, call again with replace: true.` };
          commit(session, e, { ...newCanvas(args.new.trim().slice(0, 80)) }, "agent");
        }
        setOpen(session, true);
        return { ok: true, summary: `${describeCanvas(e.canvas)}\nLibrary (place with panacea_place recipe; panacea_look library:"words" to search and see trees):\n${libraryIndex(allRecipes().filter((r) => r.origin === "builtin" || r.uses > 0), e.canvas.surfaces.length ? null : "general").slice(0, 3000)}`, preview: e.canvas.name };
      }

      case "panacea_look": {
        setOpen(session, true);
        if (typeof args.recipe === "string") {
          const r = findRecipe(args.recipe);
          if (!r) return { ok: false, summary: `There is no recipe "${args.recipe}".` };
          return { ok: true, summary: `${r.id} "${r.name}" (${r.domain}, ${r.origin}, used ${r.uses}x): ${r.about}. Width ${r.w}.\n${JSON.stringify(r.tree)}`, preview: r.name };
        }
        if (typeof args.library === "string" || typeof args.domain === "string") {
          const pool = allRecipes().filter((r) => r.origin === "builtin" || r.uses > 0);
          const found = searchLibrary(pool, String(args.library ?? ""), typeof args.domain === "string" ? args.domain : null, 12);
          return {
            ok: true,
            summary: found.length ? found.map((r) => `- ${r.id} "${r.name}" (${r.domain}${r.origin !== "builtin" ? `, ${r.origin}` : ""}, used ${r.uses}x): ${r.about}\n  ${treeWords(r.tree)}`).join("\n") : "Nothing in the library matches. Compose it from atoms (panacea_place tree), or, when atoms cannot do it, draft a bespoke piece with the person (panacea_bespoke).",
            preview: `${found.length} recipes`,
          };
        }
        const recent = e.acts.slice(-12).map((a) => a.text);
        return {
          ok: true,
          summary: [describeCanvas(e.canvas, { trees: args.trees !== false }), recent.length ? `What the person did lately: ${recent.join("; ")}.` : "", profileWords(profileNow()) ?? ""].filter(Boolean).join("\n"),
          preview: e.canvas.name,
        };
      }

      case "panacea_place":
      case "panacea_set":
      case "panacea_arrange":
      case "panacea_surface":
      case "panacea_bespoke": {
        const next = structuredClone(e.canvas);
        const done = edit(session, name, next, args, hooks);
        setOpen(session, true);
        const hand = await byHand(session, e, next);
        if (hand) e.quiet = e.rev + 1;
        commit(session, e, next, "agent");
        return { ok: true, summary: `${done.text}${hand ? ` ${hand}` : ""}`, preview: done.preview };
      }

      case "panacea_export": {
        const c = e.canvas;
        if (typeof args.panel === "string") {
          const panel = needPanel(c, args.panel);
          const out = (await command(session, "chart", { panel: panel.id, name: panel.title }, 60_000)) as { artifact?: string; name?: string; size?: number; mime?: string } | null;
          if (!out?.artifact) return { ok: false, summary: "The window could not draw that panel's chart." };
          hooks.showFile?.({ id: out.artifact, name: out.name ?? `${panel.title}.svg`, mime: out.mime ?? "image/svg+xml", size: out.size ?? 0 });
          return { ok: true, summary: `Saved ${out.name} (artifact ${out.artifact}) in the project.`, preview: out.name ?? panel.title };
        }
        const s = c.surfaces.find((x) => x.id === args.surface) ?? refuse(`Say which: \`surface\` (${c.surfaces.map((x) => x.id).join(", ") || "none on the canvas"}) or \`panel\` (a chart).`);
        if (s.kind === "data") {
          const rows = filteredRows(s.table!, s.params);
          const art = saveArtifact({ origin: "agent", name: `${(typeof args.name === "string" && args.name.trim()) || s.title}.csv`, data: Buffer.from(tableCsv(s.table!.columns, rows), "utf8"), mime: "text/csv", session, note: "Exported from Panacea" });
          hooks.showFile?.({ id: art.id, name: art.name, mime: art.mime, size: art.size });
          return { ok: true, summary: `Saved ${art.name} (${rows.length} rows, as filtered) as artifact ${art.id}, in the project.`, preview: art.name };
        }
        const format = args.format === "jpeg" ? "jpeg" : "png";
        const out = (await command(session, "render", { surface: s.id, format, name: (typeof args.name === "string" && args.name.trim()) || s.title }, 120_000)) as { artifact?: string; name?: string; size?: number; mime?: string } | null;
        if (!out?.artifact) return { ok: false, summary: "The window could not render the picture." };
        hooks.showFile?.({ id: out.artifact, name: out.name ?? `${s.title}.${format}`, mime: out.mime ?? `image/${format}`, size: out.size ?? 0 });
        return { ok: true, summary: `Saved ${out.name} (artifact ${out.artifact}), the picture with every adjustment, in the project.`, preview: out.name ?? s.title };
      }

      default:
        return { ok: false, summary: `Unknown Panacea tool: ${name}` };
    }
  } catch (err) {
    return { ok: false, summary: err instanceof Refuse ? err.message : `Panacea could not do that: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * The person loaded a file from Artifacts into the canvas (the bar's Load): a canvas they saved replaces this one; a photo
 * or a table goes on it as a surface, with its starter panels.
 */
export function loadIntoPanacea(session: string, art: { id: string; name: string }, data: Buffer): { ok: boolean; said?: string; error?: string } {
  if (!validSession(session)) return { ok: false, error: "Panacea needs a chat to work in." };
  const e = entryFor(session);
  if (/\.panacea\.json$/i.test(art.name)) {
    let raw: unknown;
    try { raw = JSON.parse(data.toString("utf8")); } catch { return { ok: false, error: "That is not a canvas Panacea kept (a .panacea.json file)." }; }
    const canvas = normalizeCanvas(raw);
    if (!canvas) return { ok: false, error: "That file has no canvas in it." };
    setOpen(session, true);
    // "agent" makes the window take a canvas it did not make itself; whose it is does not matter to it.
    commit(session, e, canvas, "agent");
    return { ok: true, said: `The canvas "${canvas.name}" is open in Panacea.` };
  }
  const next = structuredClone(e.canvas);
  try {
    if (IMAGE_EXT.test(art.name)) addSurface(next, { kind: "image", name: art.name, artifact: art.id, px: imageSize(data) });
    else if (TABLE_EXT.test(art.name)) addSurface(next, { kind: "data", name: art.name, artifact: art.id, table: readTable(art.name, data) ?? refuse(`${art.name} has no table in it.`) });
    else return { ok: false, error: "Panacea loads a canvas it kept, a photo or a table." };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  setOpen(session, true);
  commit(session, e, next, "agent");
  act(session, e, `loaded ${art.name} onto the canvas`);
  return { ok: true, said: `${art.name} is on the Panacea canvas.` };
}

// ------------------------------------------------------------------ routes --

const bigJson = express.json({ limit: "24mb" });
const rawBody = express.raw({ type: () => true, limit: MAX_ARTIFACT_BYTES });

export function panaceaRoutes(app: Express, opts: {
  exists: (session: string) => boolean;
  incognito: (session: string) => boolean;
  off: () => boolean;
  push: (session: string, message: Record<string, unknown>) => void;
}) {
  pushed = opts.push;
  const known = (req: Request, res: Response): string | null => {
    const id = String(req.params.session);
    if (!validSession(id) || !opts.exists(id)) {
      res.status(404).json({ error: "No such session." });
      return null;
    }
    return id;
  };
  const OFF = "Panacea is switched off on the Tools page.";

  /* The library, for the summon picker and the Library panel: the built-ins and what has been composed and used. */
  app.get("/api/panacea/library", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({ recipes: allRecipes().filter((r) => r.origin === "builtin" || r.uses > 0) });
  });

  app.get("/api/panacea/library/:id", (req, res) => {
    const r = findRecipe(String(req.params.id));
    if (!r) return res.status(404).json({ error: "No such recipe." });
    res.json({ recipe: r });
  });

  app.patch("/api/panacea/library/:id", express.json(), (req, res) => {
    const r = learned().find((x) => x.id === req.params.id);
    if (!r) return res.status(404).json({ error: "Only pieces made here can be renamed; the built-ins stay as they are." });
    if (typeof req.body?.name === "string" && req.body.name.trim()) r.name = req.body.name.trim().slice(0, 60);
    saveLibrary();
    res.json({ recipe: r });
  });

  app.delete("/api/panacea/library/:id", (req, res) => {
    const list = learned();
    const i = list.findIndex((x) => x.id === req.params.id);
    if (i < 0) return res.status(404).json({ error: "Only pieces made here can be deleted." });
    list.splice(i, 1);
    saveLibrary();
    res.json({ ok: true });
  });

  app.get("/api/panacea/profile", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({ profile: profileNow() });
  });

  app.get("/api/panacea/:session", (req, res) => {
    const id = known(req, res);
    if (id) res.json(panaceaState(id));
  });

  app.get("/api/panacea/:session/doc", (req, res) => {
    const id = known(req, res);
    if (!id) return;
    const e = entryFor(id);
    res.setHeader("Cache-Control", "no-store");
    res.json({ doc: e.canvas, rev: e.rev });
  });

  /* What the person did in the window: taken after it has been checked and repaired, and refused (409) when the agent
     changed the canvas since the window last loaded it, so its work is never undone unseen. */
  app.put("/api/panacea/:session/doc", bigJson, (req, res) => {
    const id = known(req, res);
    if (!id) return;
    if (opts.off()) return res.status(403).json({ error: OFF });
    const e = entryFor(id);
    const based = numberOr(req.body?.rev);
    if (based !== null && based < e.rev && e.by === "agent") return res.status(409).json({ error: "Autora changed the canvas while you were working.", rev: e.rev });
    const next = normalizeCanvas(req.body?.doc);
    if (!next) return res.status(400).json({ error: "That is not a Panacea canvas." });
    commit(id, e, next, "person");
    res.json({ rev: e.rev });
  });

  /* The person did something: for the next turn, for presence and the companion, for the suggester, and for what
     Panacea learns about them. Not a change to the canvas. */
  app.post("/api/panacea/:session/activity", express.json(), (req, res) => {
    const id = known(req, res);
    if (!id) return;
    const e = entryFor(id);
    const b = req.body ?? {};
    const p = profileNow();
    const text = typeof b.text === "string" ? b.text : "";
    if (typeof b.bind === "string" && b.bind.length <= 120) noteUse(p, usageKey(b.bind));
    if (typeof b.recipe === "string" && b.recipe.length <= 60 && b.kind === "use") noteUse(p, `recipe:${b.recipe}`);
    if (b.kind === "dismiss" && typeof b.recipe === "string") noteDismiss(p, b.recipe.slice(0, 60));
    if (b.kind === "move" && b.box && b.anchor) noteSide(p, sideOf(b.box, b.anchor));
    saveProfile();
    if (text) act(id, e, text);
    // A local rule may have something to offer at once: the page asks, and places it itself.
    let offer: { recipe: string; why: string; near: string } | null = null;
    if (typeof b.bind === "string" && b.value !== undefined) offer = suggestFor(e.canvas, b.bind, b.value as Value, (r) => quieted(p, r));
    if (text) scheduleSuggest(id, e);
    res.json({ ok: true, ...(offer ? { offer } : {}) });
  });

  /* The person used a panel for the first time: a composed panel joins the library (or counts as a use of the same shape
     already there), a bespoke draft they keep is promoted. Says the recipe id, which the window writes on the panel. */
  app.post("/api/panacea/:session/use", express.json(), (req, res) => {
    const id = known(req, res);
    if (!id) return;
    const e = entryFor(id);
    const panel = (req.body?.panel ? normalizeCanvas({ panels: [req.body.panel], surfaces: e.canvas.surfaces })?.panels[0] : null) ?? null;
    if (!panel) return res.status(400).json({ error: "No panel." });
    const builtin = BUILTINS.some((r) => r.id === panel.recipe);
    if (builtin) {
      noteUse(profileNow(), `recipe:${panel.recipe}`);
      saveProfile();
      return res.json({ recipe: panel.recipe });
    }
    const bespoke = panel.tree.atom === "bespoke";
    const recipe = learn(panel.tree, { name: panel.title, about: panel.why || panel.title, domain: domainFor(e.canvas, panel), origin: bespoke ? "bespoke" : "composed", w: panel.w }, kindsOf(e.canvas), true);
    res.json({ recipe });
  });

  /* A file dropped on the canvas: kept in the project as an artifact and read, so the window can lay it out as a
     surface. A picture's size comes back; a table comes back typed. */
  app.post("/api/panacea/:session/import", rawBody, (req, res) => {
    const id = known(req, res);
    if (!id) return;
    if (opts.off()) return res.status(403).json({ error: OFF });
    if (!Buffer.isBuffer(req.body) || !req.body.byteLength) return res.status(400).json({ error: "empty" });
    const name = String(req.query.name ?? "file").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-").slice(0, 120) || "file";
    if (IMAGE_EXT.test(name)) {
      const mime = `image/${/png$/i.test(name) ? "png" : /gif$/i.test(name) ? "gif" : /webp$/i.test(name) ? "webp" : "jpeg"}`;
      const art = saveArtifact({ origin: "user", name, data: req.body, mime, session: id, note: "Dropped on Panacea" });
      return res.json({ kind: "image", artifact: art.id, name: art.name, px: imageSize(req.body) });
    }
    if (TABLE_EXT.test(name)) {
      const table = readTable(name, req.body);
      if (!table) return res.status(400).json({ error: `${name} has no table in it: a header row and rows.` });
      const art = saveArtifact({ origin: "user", name, data: req.body, mime: /xlsx$/i.test(name) ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "text/csv", session: id, note: "Dropped on Panacea" });
      return res.json({ kind: "data", artifact: art.id, name: art.name, table });
    }
    res.status(415).json({ error: "Panacea works on photos (PNG, JPEG, GIF, WebP) and tables (CSV, TSV, XLSX) for now." });
  });

  /* Save: the canvas as it is, kept in the project's folder in Artifacts. The agent is not woken. */
  app.post("/api/panacea/:session/keep", (req, res) => {
    const id = known(req, res);
    if (!id) return;
    if (opts.off()) return res.status(403).json({ error: OFF });
    const e = entryFor(id);
    try {
      const art = keepCopy({ session: id, title: e.canvas.name || chatTitle(id), fallback: "Canvas", ext: "panacea.json", data: Buffer.from(JSON.stringify(e.canvas, null, 2), "utf8"), mime: "application/json", note: "Saved from Panacea" });
      res.json({ artifact: art.id, name: art.name });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /* A picture, a chart or a table's rows the window made (Export), kept in the project. */
  app.post("/api/panacea/:session/deliver", rawBody, (req, res) => {
    const id = known(req, res);
    if (!id) return;
    if (!Buffer.isBuffer(req.body) || req.body.byteLength < 2) return res.status(400).json({ error: "empty" });
    const given = String(req.headers["content-type"] ?? "image/png").split(";")[0]!.trim();
    const TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/svg+xml": "svg", "text/csv": "csv" };
    const ext = TYPES[given] ?? "png";
    const mime = Object.entries(TYPES).find(([, e]) => e === ext)![0];
    const raw = String(req.query.name ?? "panacea").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-").replace(/\.(png|jpe?g|svg|csv)$/i, "").slice(0, 80) || "panacea";
    const art = saveArtifact({ origin: "agent", name: `${raw}.${ext}`, data: req.body, mime, session: id, note: "Exported from Panacea" });
    res.json({ artifact: art.id, name: art.name, size: art.size, mime: art.mime });
  });

  app.post("/api/panacea/:session/open", (req, res) => {
    const id = known(req, res);
    if (!id) return;
    if (opts.off()) return res.status(403).json({ error: OFF });
    if (opts.incognito(id)) return res.status(409).json({ error: "An incognito chat keeps nothing, so it has no canvas." });
    setOpen(id, true);
    res.json(panaceaState(id));
  });

  app.post("/api/panacea/:session/close", (req, res) => {
    const id = known(req, res);
    if (!id) return;
    setOpen(id, false);
    res.json(panaceaState(id));
  });

  app.post("/api/panacea/:session/ready", express.json(), (req, res) => {
    const id = known(req, res);
    if (!id) return;
    entryFor(id).ready = req.body?.ready !== false;
    res.json({ ok: true });
  });

  app.post("/api/panacea/:session/claim", (req, res) => {
    const id = known(req, res);
    if (!id) return;
    const p = pending.get(String(req.query.id ?? ""));
    const won = !!p && p.session === id && !p.claimed;
    if (won && p) p.claimed = true;
    res.json({ won });
  });

  app.post("/api/panacea/:session/reply", bigJson, (req, res) => {
    const id = known(req, res);
    if (!id) return;
    const p = pending.get(String(req.body?.id ?? ""));
    if (p && p.session === id) {
      clearTimeout(p.timer);
      pending.delete(String(req.body.id));
      if (req.body.ok) p.resolve(req.body.value);
      else p.reject(new Error(String(req.body?.value?.message ?? "The window could not do that.")));
    }
    res.json({ ok: true });
  });
}
