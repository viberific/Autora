/**
 * Autora 3D: the 3D modelling window, and the agent's hands on the same model.
 *
 * Autora 3D (autora-3d/, a copy of the standalone 3D-Modeling app built by `npm run build`) is a sketch-and-extrude CAD
 * modeller. Here it is a window beside the conversation, and one model per chat that the agent and the person both work
 * on. The model lives on this server, in the same headless engine the app is built on (dist/autora-3d-engine/):
 *
 *   - the agent's `cad_*` tools run on it (`runCadTool`), and every change is pushed to the window, which shows it;
 *   - the person works in the window as in the app on its own, and what they change goes back here
 *     (`PUT /api/cad/:session/doc`), so the agent's next call sees it.
 *
 * Who made a change travels with it (`by`): the window reloads the model for the agent's changes and never for its
 * own person's, so a drag in progress is not interrupted by an echo of itself.
 *
 * The engine is loaded from its bundle at run time rather than imported: it is the app's own code (three.js, a WebAssembly
 * geometry kernel), built by the autora-3d sub-project, and the server is typechecked without it. Without the build the
 * tools are simply not offered (`cadAvailable`).
 */
import express, { type Express, type Request, type Response } from "express";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { keepCopy, saveArtifact } from "./artifacts";
import { FileRefError, readFileRef } from "./fileref";
import { picturesOf, restorePictures } from "../src/lib/cadPictures";
import { chatTitle } from "./folders";
import { stateDir } from "./state";
import { readDoc, saveDoc } from "./store";
import { editorMissing, staticDir } from "./staticfiles";
import { cadSPECS } from "./specs/cad";
import { MODEL_PART, isModelBind, modelCommands, type ModelDoc } from "../src/lib/panacea/apps/model";
import type { Value } from "../src/lib/panacea/atoms";

/** What the bundle's `Engine` offers the server (the rest of its API is the tools). */
interface CadEngine {
  execute(name: string, args?: unknown, options?: { ifRevision?: number }): Promise<CadResponse>;
  getDoc(): CadDoc;
  setDoc(doc: CadDoc, who?: "agent" | "person"): void;
  commandLog(): CadCommand[];
  onCommand(fn: (entry: CadCommand) => void): () => void;
  revertTo(n: number, who?: "agent" | "person"): boolean;
  subscribe(fn: (doc: CadDoc, revision: number) => void): () => void;
  toJSON(): CadDoc;
}

/** One command of the model's log: what was made, by whom, in a line (the models either side stay in the engine). */
interface CadCommand {
  n: number;
  name: string;
  who: "agent" | "person";
  ok: boolean;
  changed: boolean;
  revision: number;
  at: number;
  summary: string;
}

interface CadResponse {
  ok: boolean;
  result?: unknown;
  error?: string;
  hint?: string;
  shapes?: unknown[];
  changed: boolean;
  revision: number;
}

/** A model, as the app saves it: shapes, groups, repeats and the project library. */
interface CadDoc {
  bodies: Array<{ id: string; repeatOf?: unknown }>;
  groups: unknown[];
  repeats: unknown[];
  library: unknown[];
}

interface CadCore {
  Engine: new (doc?: CadDoc) => CadEngine;
  parseDoc(raw: unknown): CadDoc | null;
  emptyDoc(): CadDoc;
  starterDoc(): CadDoc;
  initManifold(): Promise<void>;
}

/** What the page knows about the window. */
interface CadState {
  open: boolean;
  /** When it was opened, which orders it among the other windows. */
  since?: number;
  /** Goes up on every change to the model, by anyone. */
  rev?: number;
  /** Who made the latest change. */
  by?: "agent" | "person";
  /** Shapes in the model (the copies a repeat makes are not counted). */
  shapes?: number;
  /** This revision came from a Panacea panel, which the window has already: it takes it without moving the camera. */
  quiet?: number;
}

interface Entry {
  engine: CadEngine | null;
  open: boolean;
  since: number;
  rev: number;
  by: "agent" | "person";
  shapes: number;
  /** The revision a Panacea panel made: the window takes it without lighting it up or moving the camera. */
  quiet?: number;
  /** The surface pictures this chat's model has had, by key (src/lib/cadPictures.ts): the window sends one it has seen by its key. */
  pictures?: Map<string, string>;
}

/** The most picture bytes (as characters) a chat keeps for the window to refer to; past it only the model's own are kept. */
const PICTURE_CHARS = 96 * 1024 * 1024;

/** Remembers the pictures of a model for this chat, so the window can refer to them by key. */
function keepPictures(entry: Entry, doc: unknown): void {
  const now = picturesOf(doc as Parameters<typeof picturesOf>[0]);
  if (!now.size && !entry.pictures) return;
  const store = entry.pictures ?? new Map<string, string>();
  for (const [k, v] of now) store.set(k, v);
  let size = 0;
  for (const v of store.values()) size += v.length;
  entry.pictures = size > PICTURE_CHARS ? now : store;
}

const entries = new Map<string, Entry>();
const listeners = new Set<(session: string) => void>();
const commandListeners = new Set<(session: string, entry: CadCommand) => void>();

const validSession = (id: string) => /^[A-Za-z0-9_-]{1,80}$/.test(id);

/** The engine's bundle, or null when this server was built without Autora 3D. */
function engineFile(): string | null {
  const dirs = [process.env.AUTORA_3D_ENGINE_DIR, path.join(process.cwd(), "dist", "autora-3d-engine")].filter((d): d is string => Boolean(d));
  for (const dir of dirs) {
    const file = path.join(dir, "engine.mjs");
    if (fs.existsSync(file) && fs.existsSync(path.join(dir, "manifold.wasm"))) return file;
  }
  return null;
}

/** Whether the modeller was built into this server. */
export const cadAvailable = (): boolean => engineFile() !== null;

let core: Promise<CadCore> | null = null;

/** The engine's code, loaded once. */
function loadCore(): Promise<CadCore> {
  if (!core) {
    const file = engineFile();
    if (!file) return Promise.reject(new Error("Autora 3D is not built into this server."));
    core = import(pathToFileURL(file).href)
      .then(async (m: CadCore) => {
        // The exact geometry kernel (WebAssembly) wants a moment to start; the engine falls back to a rougher one without it.
        await m.initManifold().catch(() => undefined);
        return m;
      })
      .catch((err) => {
        core = null;
        throw err;
      });
  }
  return core;
}

/** What is kept on disk for a chat: its model, and whether its window was open. */
interface Saved {
  doc: CadDoc;
  open: boolean;
  since: number;
}

const savedName = (session: string) => `cad-${session}`;

const countShapes = (doc: CadDoc | null | undefined) => (doc ? doc.bodies.filter((b) => !b.repeatOf).length : 0);

function entryFor(session: string): Entry {
  let entry = entries.get(session);
  if (!entry) {
    const saved = validSession(session) ? readDoc<Saved>(savedName(session)) : null;
    entry = {
      engine: null,
      open: Boolean(saved?.open),
      since: saved?.since ?? 0,
      rev: 0,
      by: "agent",
      shapes: countShapes(saved?.doc),
    };
    entries.set(session, entry);
  }
  return entry;
}

function changed(session: string) {
  for (const fn of listeners) fn(session);
}

/** The model of a chat, made from what was kept or empty. Changes to it are saved and announced. */
async function engineOf(session: string): Promise<CadEngine> {
  const entry = entryFor(session);
  if (entry.engine) return entry.engine;
  const c = await loadCore();
  // Another call may have made it while the engine's code was loading.
  if (entry.engine) return entry.engine;
  const saved = readDoc<Saved>(savedName(session));
  const doc = (saved && c.parseDoc(saved.doc)) || c.emptyDoc();
  const engine = new c.Engine(doc);
  entry.engine = engine;
  entry.shapes = countShapes(engine.getDoc());
  engine.onCommand((cmd) => {
    for (const fn of commandListeners) fn(session, cmd);
  });
  engine.subscribe((next) => {
    entry.rev++;
    entry.shapes = countShapes(next);
    saveDoc(savedName(session), () => ({ doc: engine.toJSON(), open: entry.open, since: entry.since }) satisfies Saved);
    changed(session);
  });
  return engine;
}

/** Remember the window being opened or put away. */
function setOpen(session: string, open: boolean) {
  const entry = entryFor(session);
  if (entry.open === open) return;
  entry.open = open;
  entry.since = open ? Date.now() : entry.since;
  const engine = entry.engine;
  if (engine) saveDoc(savedName(session), () => ({ doc: engine.toJSON(), open: entry.open, since: entry.since }) satisfies Saved);
  else {
    const saved = readDoc<Saved>(savedName(session));
    if (saved) saveDoc(savedName(session), () => ({ ...saved, open: entry.open, since: entry.since }));
  }
  changed(session);
}

export function cadState(session: string): CadState {
  if (!validSession(session)) return { open: false };
  const entry = entryFor(session);
  if (!entry.open) return { open: false };
  return { open: true, since: entry.since, rev: entry.rev, by: entry.by, shapes: entry.shapes, ...(entry.quiet === entry.rev ? { quiet: entry.rev } : {}) };
}

/** Told after every change to a chat's window or model, so the page can be told. */
export function onCadChange(fn: (session: string) => void) {
  listeners.add(fn);
}

/** Told of every command made on a chat's model (the agent's calls and the person's edits), for the event log. */
export function onCadCommand(fn: (session: string, entry: CadCommand) => void) {
  commandListeners.add(fn);
}

/** The commands made on a chat's model so far, oldest first. */
async function cadCommands(session: string): Promise<CadCommand[]> {
  if (!validSession(session)) return [];
  return (await engineOf(session)).commandLog();
}

/** The chat is gone: let go of its model, and of the file it was kept in. */
export function dropCad(session: string) {
  entries.delete(session);
  if (!validSession(session)) return;
  fs.rmSync(path.join(stateDir(), `${savedName(session)}.json`), { force: true });
}

// ------------------------------------------------------------------- tools --

/** The tool names the engine knows, as the agent sees them: cad_scene_get and so on. */
const CAD_NAMES = new Set(cadSPECS.map((s) => s.name));
const BARE = cadSPECS.map((s) => s.name.slice(4)).filter((n) => n.includes("_"));
const BARE_PATTERN = new RegExp(`(?<![\\w])(${BARE.join("|")})(?![\\w])`, "g");

/** The engine's messages name its tools without the prefix ("call scene_get"); the agent knows them with it. */
const asAgentSees = (text: string) => text.replace(BARE_PATTERN, "cad_$1");

/** A name for an exported file, with the extension its format needs. */
function exportName(wanted: unknown, format: string, fallback: string): string {
  const base = (typeof wanted === "string" && wanted.trim() ? wanted.trim() : fallback)
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-")
    .replace(/\.(stl|glb|obj|json)$/i, "")
    .slice(0, 80);
  return `${base || fallback}.${format}`;
}

const EXPORT_MIME: Record<string, string> = {
  stl: "model/stl",
  glb: "model/gltf-binary",
  obj: "text/plain",
  json: "application/json",
};

/** The most a tool result may say, in characters: a whole scene can be large and the agent can ask for less. */
const MOST = 24_000;

/** A mesh file (GLB, glTF, OBJ, STL), by its name: it is brought in as a shape, not read as a model. */
const MESH_FILE = /\.(glb|gltf|obj|stl)$/i;

/**
 * The person loads a model they kept (`.model.json`, or a document exported as JSON): it becomes the chat's model, as one
 * step of its history, and the window shows it. A mesh file (GLB, OBJ, STL) is added to the model as a shape instead, so
 * what is already there stays.
 */
export async function loadModel(session: string, data: Buffer, name = ""): Promise<{ ok: boolean; error?: string; shapes?: number }> {
  if (!validSession(session)) return { ok: false, error: "Autora 3D needs a chat to work in." };
  if (MESH_FILE.test(name)) {
    const engine = await engineOf(session);
    const entry = entryFor(session);
    setOpen(session, true);
    entry.by = "agent";
    const res = await engine.execute("mesh_import", { data: data.toString("base64"), name });
    if (!res.ok) return { ok: false, error: asAgentSees([res.error, res.hint].filter(Boolean).join(" ")) || "That mesh could not be read." };
    return { ok: true, shapes: countShapes(engine.getDoc()) };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(data.toString("utf8"));
  } catch {
    return { ok: false, error: "That is not a model Autora 3D kept (a .model.json file)." };
  }
  const c = await loadCore();
  const doc = c.parseDoc(raw);
  if (!doc) return { ok: false, error: "That file is not an Autora 3D model." };
  const engine = await engineOf(session);
  const entry = entryFor(session);
  setOpen(session, true);
  entry.by = "agent";
  engine.setDoc(doc);
  return { ok: true, shapes: countShapes(engine.getDoc()) };
}

interface CadToolHooks {
  /** Where a relative file path is read from (the host's working folder). */
  cwd?: string;
  /** Show a saved file in the thread. */
  showFile?: (file: { id: string; name: string; mime: string; size: number }) => void;
}

/**
 * Runs one `cad_*` tool on the chat's model and opens the window, so the person watches it happen.
 * Never throws: a bad call comes back as { ok: false, summary } saying what was wrong and what to try.
 */
export async function runCadTool(
  session: string,
  toolName: string,
  args: Record<string, any>,
  hooks: CadToolHooks = {},
): Promise<{ ok: boolean; summary: string; preview?: string }> {
  if (!CAD_NAMES.has(toolName)) return { ok: false, summary: `Unknown tool "${toolName}".` };
  if (!validSession(session)) return { ok: false, summary: "Autora 3D needs a chat to work in." };
  try {
    const engine = await engineOf(session);
    const name = toolName.slice(4);
    const given = { ...args };
    // Commands inside a batch name their tool either way.
    if (name === "batch" && Array.isArray(given.commands)) {
      given.commands = given.commands.map((c: any) =>
        c && typeof c.tool === "string" ? { ...c, tool: c.tool.replace(/^cad_/, "") } : c);
    }
    // A picture for a surface is named the same way; it reaches the model as the picture itself, never through the conversation.
    try {
      if (name === "surface_set") readPicture(given, hooks.cwd ?? process.cwd());
      if (name === "batch" && Array.isArray(given.commands)) {
        for (const c of given.commands as Array<{ tool?: unknown; args?: Record<string, unknown> }>) {
          if (c?.tool === "surface_set" && c.args && typeof c.args === "object") c.args = readPicture({ ...c.args }, hooks.cwd ?? process.cwd());
        }
      }
    } catch (err) {
      if (err instanceof FileRefError) return { ok: false, summary: err.message };
      throw err;
    }
    if (name === "mesh_import" && typeof given.file === "string" && given.data === undefined) {
      // The model names a file; the bytes never go through the conversation.
      try {
        const f = readFileRef(given.file, hooks.cwd ?? process.cwd(), "mesh file", "cad_mesh_import");
        given.data = f.data.toString("base64");
        given.name = given.name ?? f.name;
        delete given.file;
      } catch (err) {
        if (err instanceof FileRefError) return { ok: false, summary: err.message };
        throw err;
      }
    }
    const exportArgs = name === "export" ? { name: given.name } : null;
    if (exportArgs) delete given.name;
    const mine = entryFor(session);
    setOpen(session, true);
    mine.by = "agent";
    const res = await engine.execute(name, given);
    if (!res.ok) {
      const hint = res.hint ? ` ${asAgentSees(res.hint)}` : "";
      return { ok: false, summary: `${asAgentSees(res.error ?? "That did not work.")}${hint}`, preview: name };
    }
    if (exportArgs) {
      const r = res.result as { format?: string; filename?: string; encoding?: string; data?: string; text?: string };
      const format = String(r.format ?? "stl");
      const data = r.encoding === "base64" ? Buffer.from(r.data ?? "", "base64") : Buffer.from(r.text ?? "", "utf8");
      const art = saveArtifact({
        origin: "agent",
        app: "cad",
        name: exportName(exportArgs.name, format, "model"),
        data,
        mime: EXPORT_MIME[format] ?? "application/octet-stream",
        session,
        note: `Exported from Autora 3D as ${format.toUpperCase()}`,
      });
      hooks.showFile?.({ id: art.id, name: art.name, mime: art.mime, size: art.size });
      return { ok: true, summary: `Exported the model as ${art.name} (${data.length} bytes), saved as artifact ${art.id}. The person can download it from the thread.`, preview: art.name };
    }
    let summary = asAgentSees(JSON.stringify({ result: res.result, shapes: res.shapes, changed: res.changed, revision: res.revision }));
    if (summary.length > MOST) {
      summary = `${summary.slice(0, MOST)}\n[cut: the answer was ${summary.length} characters. Ask for less (cad_scene_get lists shapes; cad_shape_get takes one id).]`;
    }
    return { ok: true, summary: summary, preview: name };
  } catch (err) {
    return { ok: false, summary: `Autora 3D could not do that: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * A Panacea panel's `model.*` control moved (docs/PANACEA-GAPS.md, G1): the modeller's own tools make the part so, and the
 * window shows it. Used by the page (`who` "person": taken without a flash) and by the agent (`panacea_set`). Refuses,
 * with the reason, rather than half-doing it.
 */
export async function cadPanel(session: string, bind: string, value: unknown, part: unknown, who: "agent" | "person"): Promise<{ ok: true; did: string } | { ok: false; error: string }> {
  if (!validSession(session)) return { ok: false, error: "Autora 3D needs a chat to work in." };
  if (!isModelBind(bind) || bind === MODEL_PART) return { ok: false, error: `nothing in the model answers to ${bind}` };
  try {
    const engine = await engineOf(session);
    const plan = modelCommands(engine.getDoc() as unknown as ModelDoc, bind, value as Value, part);
    if ("error" in plan) return { ok: false, error: plan.error };
    const entry = entryFor(session);
    setOpen(session, true);
    for (const c of plan.commands) {
      // Each call is one change (one revision); the last is the one the window takes quietly.
      entry.by = "agent";
      if (who === "person") entry.quiet = entry.rev + 1;
      const res = await engine.execute(c.tool, c.args);
      if (!res.ok) return { ok: false, error: asAgentSees(res.error ?? "that did not work") };
    }
    return { ok: true, did: plan.did };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** The model as it is now if its engine is running (it is once anything has used it), for what the agent reads off the canvas. */
export function cadModel(session: string): ModelDoc | null {
  if (!validSession(session)) return null;
  return (entries.get(session)?.engine?.getDoc() as unknown as ModelDoc | undefined) ?? null;
}

/**
 * A surface_set's pictures (`image`, `reliefImage`, `roughnessImage`) name files (an artifact or a path): each becomes the
 * picture, as a data URL, before the model sees it.
 */
function readPicture(args: Record<string, unknown>, cwd: string): Record<string, unknown> {
  for (const slot of ["image", "reliefImage", "roughnessImage"]) {
    const ref = args[slot];
    if (typeof ref !== "string" || ref.startsWith("data:")) continue;
    const f = readFileRef(ref, cwd, "picture", "cad_surface_set");
    const png = f.data[0] === 0x89 && f.data[1] === 0x50 && f.data[2] === 0x4e && f.data[3] === 0x47;
    const jpg = f.data[0] === 0xff && f.data[1] === 0xd8;
    if (!png && !jpg) throw new FileRefError(`${f.name} is not a PNG or a JPEG; a surface's picture must be one.`);
    args[slot] = `data:image/${png ? "png" : "jpeg"};base64,${f.data.toString("base64")}`;
  }
  return args;
}

/** Which of the model's tools exist, for the capability briefing. */
export function cadBriefing(on: boolean): string {
  if (!on) {
    return "- Autora 3D (the 3D modelling window): switched off on the Tools page. Do not try to model in 3D, and if asked, say it is off.";
  }
  return (
    "- Autora 3D (the 3D modelling window): available. Tools: the cad_* family -- start with cad_scene_get; cad_export gives " +
    "STL to print or GLB for games. cad_mesh_import brings in a GLB, OBJ or STL file as a real surface (an animal, a face, a scan: " +
    "the extruded shapes cannot make those, so for organic forms build them or import a free CC0 mesh). " +
    "cad_sculpt_blend makes ONE smooth organic shape by melting spheres, tapered capsules and ellipsoids together (an animal's body, neck, head and legs; mirror reflects half of it), " +
    "cad_sculpt_loft a smooth tube through changing cross-sections (a leg, tail, horn), and cad_sculpt_smooth evens out any mesh shape. " +
    "cad_rig_add gives the model a 29-bone skeleton (bip29), cad_rig_bind ties the shapes to it, cad_rig_pose previews a pose, and cad_export with rig:true writes a skinned GLB. " +
    "cad_surface_set: glass, velvet, skin, patterns, pictures; cad_hair_set: hair or fur (the person grooms it); cad_scene_look: the light. " +
    "Shapes are flat outlines pushed up to a height, in millimetres, x right, y away, z up. Model what the person asks to " +
    "make, print or design with these, not code. The window opens beside the chat on first use and the person can work " +
    "in it too: call cad_scene_get again before relying on what you saw earlier. Check a part with cad_shape_measure " +
    "(watertight) before exporting. Design choices are theirs: suggest, and ask when it matters."
  );
}

// ------------------------------------------------------------------ routes --

const bigJson = express.json({ limit: "64mb" });

/** The window's side of the wire: its state, its model, and opening and putting it away. */
export function cadRoutes(app: Express, opts: {
  exists: (session: string) => boolean;
  incognito: (session: string) => boolean;
  off: () => boolean;
}) {
  const known = (req: Request, res: Response): string | null => {
    const id = String(req.params.session);
    if (!validSession(id) || !opts.exists(id)) {
      res.status(404).json({ error: "No such session." });
      return null;
    }
    if (!cadAvailable()) {
      res.status(503).json({ error: "Autora 3D is not built into this server." });
      return null;
    }
    return id;
  };

  app.get("/api/cad/:session", (req, res) => {
    const id = known(req, res);
    if (id) res.json(cadState(id));
  });

  app.get("/api/cad/:session/doc", async (req, res) => {
    const id = known(req, res);
    if (!id) return;
    try {
      const engine = await engineOf(id);
      res.setHeader("Cache-Control", "no-store");
      const entry = entryFor(id);
      const doc = engine.getDoc();
      keepPictures(entry, doc);
      res.json({ doc, rev: entry.rev });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /* A panel's 3D control moved (Panacea): the modeller makes it so, in one place for the person and the agent. */
  app.post("/api/cad/:session/panel", express.json({ limit: "64kb" }), async (req, res) => {
    const id = known(req, res);
    if (!id) return;
    if (opts.off()) return res.status(403).json({ error: "Autora 3D is switched off on the Tools page." });
    const bind = typeof req.body?.bind === "string" ? req.body.bind : "";
    const done = await cadPanel(id, bind, req.body?.value, req.body?.part, "person");
    if (!done.ok) return res.status(400).json({ error: done.error });
    res.json({ rev: entryFor(id).rev, did: done.did });
  });

  /* What the person did in the window. Taken as it is (the engine parses and settles it), so a stale or malformed
     document is refused rather than saved. */
  app.put("/api/cad/:session/doc", bigJson, async (req, res) => {
    const id = known(req, res);
    if (!id) return;
    if (opts.off()) return res.status(403).json({ error: "Autora 3D is switched off on the Tools page." });
    try {
      const c = await loadCore();
      const engine = await engineOf(id);
      const entry = entryFor(id);
      // Pictures the window knows the server holds come as their keys: put them back before the model is read.
      keepPictures(entry, engine.getDoc());
      const given = req.body?.doc && typeof req.body.doc === "object" ? restorePictures(req.body.doc, entry.pictures ?? new Map()) : null;
      if (given?.missing.length) return res.status(409).json({ error: "Some pictures are not here any more; send them whole.", missing: given.missing });
      const doc = c.parseDoc(given?.doc);
      if (!doc) return res.status(400).json({ error: "That is not an Autora 3D model." });
      keepPictures(entry, doc);
      // Stays "person" until the agent's next tool call says otherwise: that is who made the latest change.
      entry.by = "person";
      engine.setDoc(doc, "person");
      res.json({ rev: entry.rev });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /* The log of what was made on the model, by whom (docs/ENGINE-SURVEY.md, the command layer). */
  app.get("/api/cad/:session/commands", async (req, res) => {
    const id = known(req, res);
    if (!id) return;
    try {
      res.json({ commands: await cadCommands(id) });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /* The person goes back to before a command (the window's history list). A new change on top, so it can be undone. */
  app.post("/api/cad/:session/revert", async (req, res) => {
    const id = known(req, res);
    if (!id) return;
    if (opts.off()) return res.status(403).json({ error: "Autora 3D is switched off on the Tools page." });
    const n = Number(req.body?.n);
    if (!Number.isInteger(n)) return res.status(400).json({ error: "n must be a command number from the log." });
    try {
      const engine = await engineOf(id);
      entryFor(id).by = "person";
      if (!engine.revertTo(n, "person")) return res.status(404).json({ error: "That command changed nothing or is no longer kept." });
      res.json({ rev: entryFor(id).rev });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /* The person pressed Save: the model as it is now, kept in Artifacts as a GLB (colours and groups kept; it opens in
     most 3D viewers). The agent is not asked and not woken. */
  app.post("/api/cad/:session/keep", async (req, res) => {
    const id = known(req, res);
    if (!id) return;
    if (opts.off()) return res.status(403).json({ error: "Autora 3D is switched off on the Tools page." });
    try {
      const engine = await engineOf(id);
      const out = await engine.execute("export", { format: "glb" });
      if (!out.ok) return res.status(400).json({ error: asAgentSees(out.error ?? "There is nothing to save.") });
      const r = out.result as { data?: string };
      const art = keepCopy({
        session: id, title: chatTitle(id), fallback: "Model", ext: "glb",
        data: Buffer.from(r.data ?? "", "base64"), mime: EXPORT_MIME.glb, note: "Saved from Autora 3D", app: "cad",
      });
      // The model itself too, as JSON: a GLB opens in other programs, this is what Load takes back in.
      keepCopy({
        session: id, title: chatTitle(id), fallback: "Model", ext: "model.json",
        data: Buffer.from(JSON.stringify(engine.toJSON(), null, 2), "utf8"), mime: "application/json", note: "Saved from Autora 3D (the model, to load again)", app: "cad",
      });
      res.json({ artifact: art.id, name: art.name });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /* The person opens it from the toolbox: a block to start from, so there is something to hold. */
  app.post("/api/cad/:session/open", async (req, res) => {
    const id = known(req, res);
    if (!id) return;
    if (opts.off()) return res.status(403).json({ error: "Autora 3D is switched off on the Tools page." });
    if (opts.incognito(id)) return res.status(409).json({ error: "An incognito chat keeps nothing, so it has no 3D window." });
    try {
      const c = await loadCore();
      const engine = await engineOf(id);
      if (countShapes(engine.getDoc()) === 0) {
        entryFor(id).by = "agent";
        engine.setDoc(c.starterDoc());
      }
      setOpen(id, true);
      res.json({ ...cadState(id), name: "Your model" });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/cad/:session/close", (req, res) => {
    const id = known(req, res);
    if (!id) return;
    setOpen(id, false);
    res.json(cadState(id));
  });
}

/**
 * The window's page, served to the frame that holds it. It is Autora's own code, in a frame of this origin
 * (the window talks to it by postMessage only), so it may be framed by this app and by nothing else.
 */
export function serveCad(app: Express, dist: string): void {
  app.use(
    "/autora-3d",
    (_req, res, next) => {
      res.setHeader(
        "Content-Security-Policy",
        [
          "default-src 'self'",
          "script-src 'self' 'wasm-unsafe-eval'",
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data: blob:",
          "font-src 'self' data:",
          "worker-src 'self' blob:",
          "connect-src 'self'",
          "frame-ancestors 'self'",
        ].join("; "),
      );
      res.setHeader("X-Content-Type-Options", "nosniff");
      next();
    },
    editorMissing(path.join(dist, "autora-3d"), "The 3D editor"),
    ...staticDir(path.join(dist, "autora-3d"), { fallthrough: false }),
  );
}

// ------------------------------------------------------------------ to a game --

type ModelBody = { id: string; name: string; visible: boolean; points: Array<{ x: number; y: number }>; extrusionHeight: number; elevation?: number; groupId?: string; repeatOf?: string; frame?: unknown };
type ModelGroup = { id: string; name: string; bodyIds: string[] };

/** A part of the chat's model as a game takes it: a GLB of the shapes (centred on the ground), its size, and what it was made of. */
interface ModelForGame {
  glb: Buffer;
  /** Its size, mm: x across, y deep, z tall. */
  size: { x: number; y: number; z: number };
  /** The shapes it was made of (their ids), so it can be made again when they change. */
  shapes: string[];
  /** A name for it: the group's or the shape's, or "Model". */
  name: string;
}

/**
 * The shapes `pick` names in this chat's model (shape or group ids or names; nothing means everything visible), as one GLB a
 * game can use. Shapes and their copies, groups whole, hidden ones left out. An error says what was not found.
 */
export async function modelForGame(session: string, pick: string[] = [], hair = true): Promise<ModelForGame | { error: string }> {
  if (!validSession(session)) return { error: "Autora 3D needs a chat to work in." };
  if (!cadAvailable()) return { error: "Autora 3D is not built on this server." };
  const engine = await engineOf(session);
  const doc = engine.getDoc() as unknown as { bodies: ModelBody[]; groups: ModelGroup[]; repeats: unknown[]; library: unknown[] };
  const visible = doc.bodies.filter((b) => b.visible);
  if (!visible.length) return { error: "The 3D model has nothing visible to send. Make or show something in Autora 3D first." };
  const wanted = new Set<string>();
  const missing: string[] = [];
  let name = "";
  for (const raw of pick) {
    const p = raw.trim();
    const group = doc.groups.find((g) => g.id === p || g.name.toLowerCase() === p.toLowerCase());
    const body = doc.bodies.find((b) => b.id === p || b.name.toLowerCase() === p.toLowerCase());
    if (group) { group.bodyIds.forEach((id) => wanted.add(id)); name ||= group.name; }
    else if (body) { wanted.add(body.id); name ||= body.name; }
    else missing.push(p);
  }
  if (missing.length) return { error: `The model has no shape or group called ${missing.map((m) => `"${m}"`).join(", ")}. Shapes: ${doc.bodies.filter((b) => !b.repeatOf).slice(0, 12).map((b) => b.name).join(", ")}; groups: ${doc.groups.map((g) => g.name).join(", ") || "none"}.` };
  // A live repeat's copies go with their shape.
  const chosen = pick.length ? visible.filter((b) => wanted.has(b.id) || (b.repeatOf && wanted.has(b.repeatOf))) : visible;
  if (!chosen.length) return { error: "Those shapes are hidden; show them first." };
  const c = await loadCore();
  const ids = new Set(chosen.map((b) => b.id));
  const part = c.parseDoc({ ...doc, bodies: chosen, groups: doc.groups.filter((g) => g.bodyIds.some((id) => ids.has(id))).map((g) => ({ ...g, bodyIds: g.bodyIds.filter((id) => ids.has(id)) })), repeats: [] });
  if (!part) return { error: "That part of the model could not be read." };
  const res = await new c.Engine(part).execute("export", { format: "glb", pivot: "asset", hair });
  const out = res.result as { data?: string } | undefined;
  if (!res.ok || !out?.data) return { error: asAgentSees(res.error ?? "The model could not be exported.") };
  const xs = chosen.flatMap((b) => b.points.map((p) => p.x));
  const ys = chosen.flatMap((b) => b.points.map((p) => p.y));
  const lo = Math.min(...chosen.map((b) => b.elevation ?? 0));
  const hi = Math.max(...chosen.map((b) => (b.elevation ?? 0) + b.extrusionHeight));
  const round = (n: number) => Math.round(n * 100) / 100;
  return {
    glb: Buffer.from(out.data, "base64"),
    size: { x: round(Math.max(...xs) - Math.min(...xs)), y: round(Math.max(...ys) - Math.min(...ys)), z: round(hi - lo) },
    shapes: chosen.filter((b) => !b.repeatOf).map((b) => b.id),
    name: name || (chosen.length === 1 ? chosen[0].name : "Model"),
  };
}

/** Be told when a chat's model changes (any change, by anyone): what follows the model elsewhere (a game) updates from it. */
export async function onModelChange(session: string, fn: () => void): Promise<() => void> {
  const engine = await engineOf(session);
  return engine.subscribe(() => fn());
}
