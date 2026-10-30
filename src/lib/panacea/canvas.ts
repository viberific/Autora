/**
 * A Panacea canvas: one per chat. Surfaces (the work: a photo, a table), panels (controls built from atoms, bound to the
 * surfaces' parameters and to shared values), the shared values themselves, and what the person is working on (`focus`).
 *
 * Panels come and go with the work. A panel belongs to a context (the surface it works on, or "general"); when the
 * focus moves to another surface its panels dim, and when the work moves on again they go, into `gone`, from which one
 * click brings one back. A pinned panel stays whatever happens. A ghost is a suggestion (dashed, with its reason): taken
 * with a click, or left to drift away. A draft is a bespoke piece being worked out with the person.
 *
 * Pure: plain JSON in and out, so the server keeps it and the page edits the same thing.
 */
import { emptyValue, valueFits, type Value } from "./atoms";
import { checkTree, kindAt, parseBind, surfacesOf, treeWords, type CheckContext, type Node } from "./recipe";
import { KINDS, findParam, isKind, paramsOf, type SurfaceKind } from "./kinds";
import type { DocState } from "./document";
import type { Table } from "./surfaces";

export type PanelState = "live" | "dim" | "ghost" | "draft";
export type Who = "agent" | "person" | "rule";

export interface Panel {
  id: string;
  title: string;
  tree: Node;
  /** The library recipe it came from, if any. */
  recipe?: string;
  x: number;
  y: number;
  w: number;
  /** 0: as tall as what it holds. */
  h: number;
  pinned?: boolean;
  /** Panels grouped together move together. */
  group?: string;
  state: PanelState;
  /** The surface it works on, or "general". */
  context: string;
  /** Why it is here, in a sentence: shown under its ⓘ, so the person can say "not this". */
  why: string;
  by: Who;
  at: number;
  /** When the person last used one of its controls. */
  touched?: number;
  /** More is open. */
  expanded?: boolean;
  /** "agent": Autora may fill its text and list fields (the person let it, or it is productivity work). Absent, the words
   * in them are the person's: the agent's panacea_set and panacea_place refuse them (`wordsOwner`). */
  writes?: "agent";
}

export interface Surface {
  id: string;
  kind: SurfaceKind;
  title: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** The file it was made from: an artifact id, for an image the picture itself. */
  artifact?: string;
  name: string;
  params: Record<string, Value>;
  /** A data surface's rows. */
  table?: Table;
  /** An image's size in pixels. */
  px?: { w: number; h: number };
  /** A document's tree, selection and who writes (`params` are read off it: kinds.ts `settle`). */
  doc?: DocState;
}

export interface Canvas {
  version: 1;
  name: string;
  panels: Panel[];
  surfaces: Surface[];
  /** Shared values: every control bound to the same name shows and sets the same value, so panels link by naming one. */
  values: Record<string, Value>;
  /** The surface the person is working on, or null. */
  focus: string | null;
  /** Panels that faded away lately, newest last: one click brings one back. */
  gone: Panel[];
}

export const GRID = 16;
export const MAX_PANELS = 40;
export const MAX_SURFACES = 12;
const MAX_GONE = 8;
export const PANEL_MIN_W = 176;
export const PANEL_MAX_W = 960;

export const snap = (n: number) => Math.round(n / GRID) * GRID;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export function newCanvas(name = "Canvas"): Canvas {
  return { version: 1, name, panels: [], surfaces: [], values: {}, focus: null, gone: [] };
}

let counter = 0;
/** An id that is short and will not repeat in a canvas. */
export function uid(prefix: string): string {
  counter = (counter + 1) % 1296;
  return `${prefix}${Date.now().toString(36).slice(-5)}${counter.toString(36).padStart(2, "0")}${Math.floor(Math.random() * 36).toString(36)}`;
}

export function contextOf(canvas: Pick<Canvas, "surfaces">, near?: CheckContext["near"]): CheckContext {
  return { surfaces: canvas.surfaces.map((s) => ({ id: s.id, kind: s.kind, table: s.table ?? null })), near };
}

/** A surface's parameters at their defaults, then what was set. */
export function surfaceParams(kind: SurfaceKind, table: Table | null | undefined, set: Record<string, unknown> = {}): Record<string, Value> {
  const out: Record<string, Value> = {};
  for (const p of paramsOf(kind, table)) {
    const v = set[p.name];
    out[p.name] = v !== undefined && valueFits(p.kind, v) ? (v as Value) : p.default;
  }
  return out;
}

// ------------------------------------------------------------------ values --

/** The value at a bind: a surface's parameter or a shared value. */
export function valueAt(canvas: Canvas, key: string): Value | undefined {
  const { surface, param } = parseBind(key);
  if (surface === null) return canvas.values[param];
  return canvas.surfaces.find((s) => s.id === surface)?.params[param];
}

/** Value kinds that hold the person's words: a text field, a list. */
const WORDS = new Set(["text", "list"]);

/** A panel has fields of words: the only panels the "You write" switch is shown on. */
export function holdsWords(tree: Node): boolean {
  const walk = (n: Node): boolean => (!!n.bind && parseBind(n.bind).surface === null && WORDS.has(kindAt(n, n.bind) ?? "")) || !!n.children?.some(walk);
  return walk(tree);
}

/**
 * The panel whose words are at a shared key and are the person's to write, or null when the agent may set it. Only text and
 * list fields bound to shared values count: a surface's parameters (a search box over a table) and other controls are not words.
 */
export function wordsOwner(canvas: Canvas, key: string): Panel | null {
  const { surface, param } = parseBind(key);
  if (surface !== null) return null;
  return canvas.panels.find((p) => p.writes !== "agent" && WORDS.has(kindAt(p.tree, param) ?? "")) ?? null;
}

/** Why a value cannot go at a key, or null when it can: the parameter's kind, or the kind of the controls bound to a shared value. */
export function valueProblem(canvas: Canvas, key: string, v: unknown): string | null {
  const { surface, param } = parseBind(key);
  if (surface !== null) {
    const s = canvas.surfaces.find((x) => x.id === surface);
    if (!s) return `no surface ${surface}`;
    const p = findParam(s.kind, s.table, param);
    if (!p) return `${surface} has no parameter ${param}`;
    if (p.derived) return `${key} is worked out from the work and cannot be set`;
    if (!valueFits(p.kind, v)) return `${key} is ${p.kind}${p.options ? ` (one of ${p.options.slice(0, 12).join(", ")})` : ""}`;
    if (p.kind === "choice" && p.options && !p.options.includes(v as string)) return `${key} is one of ${p.options.slice(0, 20).join(", ")}`;
    return null;
  }
  for (const panel of canvas.panels) {
    const kind = kindAt(panel.tree, param);
    if (kind && !valueFits(kind, v)) return `${param} is shown by a control that holds ${kind}`;
  }
  if (v === undefined) return "no value";
  return null;
}

/** Set a value (already checked), clamped to a parameter's range. */
export function setValue(canvas: Canvas, key: string, v: Value): void {
  const { surface, param } = parseBind(key);
  if (surface === null) { canvas.values[param] = v; return; }
  const s = canvas.surfaces.find((x) => x.id === surface);
  if (!s) return;
  const p = findParam(s.kind, s.table, param);
  if (p?.kind === "number" && typeof v === "number") v = clamp(v, p.min ?? -Infinity, p.max ?? Infinity);
  s.params[param] = v;
  // Work a value is applied to (a document's style) takes it on itself, and its parameters are read back off it.
  KINDS[s.kind].apply?.(s, param, v);
  KINDS[s.kind].settle?.(s);
}

/** A shared value nobody has set starts as the empty value of the first control bound to it. */
export function seedValues(canvas: Canvas, tree: Node): void {
  const walk = (n: Node) => {
    if (n.bind && !n.bind.startsWith("@") && canvas.values[n.bind] === undefined) {
      const kind = kindAt(n, n.bind);
      if (kind) canvas.values[n.bind] = emptyValue(kind);
    }
    n.children?.forEach(walk);
  };
  walk(tree);
}

// ------------------------------------------------------------------ layout --

interface Box { x: number; y: number; w: number; h: number }

const overlaps = (a: Box, b: Box, pad = GRID) =>
  a.x < b.x + b.w + pad && a.x + a.w + pad > b.x && a.y < b.y + b.h + pad && a.y + a.h + pad > b.y;

/** Roughly how tall a panel will draw, for placing before it has been measured. */
export function estimateHeight(tree: Node, w = 288): number {
  let h = 52;
  // A chart keeps the shape of its drawing, so it is as tall as the panel is wide allows.
  const inner = Math.max(120, w - 28);
  const walk = (n: Node, hidden: boolean) => {
    const off = hidden || n.advanced === true;
    if (off) return;
    switch (n.atom) {
      case "stack": case "row": case "group": break;
      case "divider": h += 12; break;
      case "chart": h += Math.round((inner * 220) / 420) + 8; break;
      case "table": h += Math.min(340, 60 + 26 * Number(n.props?.limit ?? 10)); break;
      case "histogram": h += 96; break;
      case "curve": case "xy": h += 180; break;
      case "lanes": h += 120; break;
      case "pads": h += 28 * Number(n.props?.rows ?? 2) + 24; break;
      case "list": h += 130; break;
      case "bespoke": h += Number(n.props?.height ?? 240); break;
      case "text": h += n.props?.multiline ? 96 : 56; break;
      default: h += 46;
    }
    n.children?.forEach((c) => walk(c, off));
  };
  walk(tree, false);
  return Math.min(720, h);
}

/** The boxes things already take on the canvas. */
function taken(canvas: Canvas, except?: string): Box[] {
  return [
    ...canvas.surfaces.map((s) => ({ x: s.x, y: s.y, w: s.w, h: s.h })),
    ...canvas.panels.filter((p) => p.id !== except && p.state !== "dim").map((p) => ({ x: p.x, y: p.y, w: p.w, h: p.h || estimateHeight(p.tree, p.w) })),
  ];
}

export type Side = "right" | "left" | "below" | "above";

/**
 * Where a panel of this size goes: beside what it works on (`near`, a surface or panel id), on the side the person
 * tends to put such panels (`side`), in the first spot that is free; snapped to the grid. With nothing to be near, the
 * middle of what is on screen (`view`), or the origin.
 */
export function placeFor(canvas: Canvas, w: number, h: number, near?: string | null, side: Side = "right", view?: Box): { x: number; y: number } {
  const boxes = taken(canvas);
  const anchor: Box | undefined =
    canvas.surfaces.find((s) => s.id === near) ?? canvas.panels.find((p) => p.id === near) ??
    (canvas.focus ? canvas.surfaces.find((s) => s.id === canvas.focus) : undefined);
  const free = (b: Box) => !boxes.some((o) => overlaps(b, o));
  const seen = (b: Box) => !view || (b.x >= view.x && b.y >= view.y && b.x + b.w <= view.x + view.w && b.y + b.h <= view.y + view.h);
  if (anchor) {
    const ah = anchor.h || 240;
    const sides: Side[] = [side, ...(["right", "below", "left", "above"] as Side[]).filter((s) => s !== side)];
    // On screen first, when the page says what is on screen; then anywhere beside it.
    // Beside it, a lane at a time (a second column on the same side before the other side), never so far down or
    // along that it is no longer beside it.
    for (const onScreen of view ? [true, false] : [false]) for (const s of sides) for (let lane = 0; lane < 3; lane++) {
      for (let i = 0; i < 24; i++) {
        const step = i * GRID * 2;
        const b: Box =
          s === "right" ? { x: anchor.x + anchor.w + GRID * 2 + lane * (w + GRID * 2), y: anchor.y + step, w, h } :
          s === "left" ? { x: anchor.x - (w + GRID * 2) * (lane + 1), y: anchor.y + step, w, h } :
          s === "below" ? { x: anchor.x + step, y: anchor.y + ah + GRID * 2 + lane * (h + GRID * 2), w, h } :
          { x: anchor.x + step, y: anchor.y - (h + GRID * 2) * (lane + 1), w, h };
        if ((s === "right" || s === "left") && b.y > anchor.y + ah) break;
        if ((s === "below" || s === "above") && b.x > anchor.x + anchor.w) break;
        if (free(b) && (!onScreen || seen(b))) return { x: snap(b.x), y: snap(b.y) };
      }
    }
  }
  const cx = view ? view.x + view.w / 2 - w / 2 : 0;
  const cy = view ? view.y + view.h / 3 - h / 2 : 0;
  for (let ring = 0; ring < 40; ring++) {
    for (let k = 0; k < Math.max(1, ring * 8); k++) {
      const a = (k / Math.max(1, ring * 8)) * Math.PI * 2;
      const b = { x: cx + Math.cos(a) * ring * GRID * 3, y: cy + Math.sin(a) * ring * GRID * 3, w, h };
      if (free(b)) return { x: snap(b.x), y: snap(b.y) };
    }
  }
  return { x: snap(cx), y: snap(cy) };
}

/** The free spot for a box nearest to a point (its middle there if that is free), snapped to the grid. */
export function nearestFree(canvas: Canvas, w: number, h: number, at: { x: number; y: number }): { x: number; y: number } {
  const boxes = taken(canvas);
  const cx = at.x - w / 2;
  const cy = at.y - h / 2;
  for (let ring = 0; ring < 60; ring++) {
    const n = Math.max(1, ring * 8);
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2;
      const b = { x: snap(cx + Math.cos(a) * ring * GRID * 2), y: snap(cy + Math.sin(a) * ring * GRID * 2), w, h };
      if (!boxes.some((o) => overlaps(b, o))) return { x: b.x, y: b.y };
    }
  }
  return { x: snap(cx), y: snap(cy) };
}

// -------------------------------------------------------------------- focus --

/**
 * The person (or the agent) moved to working on `focus`. Panels of the old work dim; panels already dim from an earlier
 * move go, into `gone`; panels of the new work come back. Pinned panels, ghosts and drafts are left alone; "general"
 * panels stay unless their values were bound to nothing on screen. Returns how many dimmed and went.
 */
export function refocus(canvas: Canvas, focus: string | null): { dimmed: number; gone: number; back: number } {
  const was = canvas.focus;
  if (was === focus) return { dimmed: 0, gone: 0, back: 0 };
  canvas.focus = focus;
  let dimmed = 0;
  let back = 0;
  const leaving: Panel[] = [];
  for (const p of canvas.panels) {
    if (p.pinned || p.state === "ghost" || p.state === "draft") continue;
    if (p.context === focus && p.state === "dim") { p.state = "live"; back++; continue; }
    if (p.context === "general" || p.context === focus) continue;
    if (p.state === "dim") leaving.push(p);
    else if (p.context === was) { p.state = "dim"; dimmed++; }
  }
  for (const p of leaving) fade(canvas, p.id);
  return { dimmed, gone: leaving.length, back };
}

/** Take a panel off the canvas into `gone` (a ghost or a draft simply goes). */
export function fade(canvas: Canvas, id: string): Panel | null {
  const i = canvas.panels.findIndex((p) => p.id === id);
  if (i < 0) return null;
  const [p] = canvas.panels.splice(i, 1);
  if (p!.state === "ghost" || p!.state === "draft") return p!;
  canvas.gone = [...canvas.gone.filter((g) => g.id !== p!.id), { ...p!, state: "live" as const }].slice(-MAX_GONE);
  return p!;
}

/** Bring a gone panel back where it was, live. */
export function restore(canvas: Canvas, id: string): Panel | null {
  const p = canvas.gone.find((g) => g.id === id);
  if (!p) return null;
  canvas.gone = canvas.gone.filter((g) => g.id !== id);
  const back: Panel = { ...p, state: "live", at: Date.now() };
  const spot = placeFor(canvas, back.w, back.h || estimateHeight(back.tree, back.w), back.context !== "general" ? back.context : null);
  if (taken(canvas).some((o) => overlaps(back, o, 0))) Object.assign(back, spot);
  canvas.panels.push(back);
  return back;
}

/** A surface removed takes its panels with it, and the values bound to it. */
export function removeSurface(canvas: Canvas, id: string): boolean {
  if (!canvas.surfaces.some((s) => s.id === id)) return false;
  canvas.surfaces = canvas.surfaces.filter((s) => s.id !== id);
  canvas.panels = canvas.panels.filter((p) => p.context !== id && !surfacesOf(p.tree).includes(id));
  canvas.gone = canvas.gone.filter((p) => p.context !== id && !surfacesOf(p.tree).includes(id));
  if (canvas.focus === id) canvas.focus = canvas.surfaces[0]?.id ?? null;
  return true;
}

// --------------------------------------------------------------- checking --

const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const str = (v: unknown, d: string, max = 80) => (typeof v === "string" ? v.slice(0, max) : d);
const STATES: PanelState[] = ["live", "dim", "ghost", "draft"];

function readPanel(raw: unknown, ctx: CheckContext, ids: Set<string>): Panel | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" && /^[\w-]{1,40}$/.test(r.id) && !ids.has(r.id) ? r.id : null;
  if (!id) return null;
  const checked = checkTree(r.tree, { ...ctx, lenient: true });
  if (!checked.tree) return null;
  ids.add(id);
  return {
    id,
    title: str(r.title, "Panel", 60),
    tree: checked.tree,
    ...(typeof r.recipe === "string" ? { recipe: r.recipe.slice(0, 60) } : {}),
    x: snap(num(r.x, 0)),
    y: snap(num(r.y, 0)),
    w: clamp(snap(num(r.w, 288)), PANEL_MIN_W, PANEL_MAX_W),
    h: num(r.h, 0) > 0 ? clamp(snap(num(r.h, 0)), 80, 900) : 0,
    ...(r.pinned === true ? { pinned: true } : {}),
    ...(typeof r.group === "string" && /^[\w-]{1,40}$/.test(r.group) ? { group: r.group } : {}),
    state: STATES.includes(r.state as PanelState) ? (r.state as PanelState) : "live",
    context: typeof r.context === "string" ? r.context.slice(0, 40) : "general",
    why: str(r.why, "", 240),
    by: r.by === "person" || r.by === "rule" ? r.by : "agent",
    at: num(r.at, Date.now()),
    ...(typeof r.touched === "number" ? { touched: r.touched } : {}),
    ...(r.expanded === true ? { expanded: true } : {}),
    ...(r.writes === "agent" ? { writes: "agent" as const } : {}),
  };
}

function readSurface(raw: unknown, ids: Set<string>): Surface | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" && /^[\w-]{1,40}$/.test(r.id) && !ids.has(r.id) ? r.id : null;
  const kind = isKind(r.kind) ? r.kind : null;
  if (!id || !kind) return null;
  const extra = KINDS[kind].read(r);
  if (!extra) return null;
  const table = extra.table;
  ids.add(id);
  const params = surfaceParams(kind, table, r.params && typeof r.params === "object" ? (r.params as Record<string, unknown>) : {});
  const px = r.px && typeof r.px === "object" ? { w: num((r.px as Box).w, 0), h: num((r.px as Box).h, 0) } : undefined;
  const surface: Surface = {
    id, kind,
    title: str(r.title, KINDS[kind].title, 80),
    x: snap(num(r.x, 0)), y: snap(num(r.y, 0)),
    w: clamp(snap(num(r.w, 480)), 160, 2400), h: clamp(snap(num(r.h, 320)), 96, 2400),
    ...(typeof r.artifact === "string" && /^[\w-]{1,80}$/.test(r.artifact) ? { artifact: r.artifact } : {}),
    name: str(r.name, "", 200),
    params,
    ...(table ? { table } : {}),
    ...(extra.doc ? { doc: extra.doc } : {}),
    ...(px && px.w > 0 ? { px } : {}),
  };
  KINDS[kind].settle?.(surface);
  return surface;
}

/** A canvas from anywhere (disk, the page, an old version), checked and repaired; null when it is not one. */
export function normalizeCanvas(raw: unknown): Canvas | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.panels) || !Array.isArray(r.surfaces)) return null;
  const sids = new Set<string>();
  const surfaces = r.surfaces.slice(0, MAX_SURFACES).map((s) => readSurface(s, sids)).filter((s): s is Surface => s !== null);
  const ctx = contextOf({ surfaces });
  const pids = new Set<string>();
  const panels = r.panels.slice(0, MAX_PANELS).map((p) => readPanel(p, ctx, pids)).filter((p): p is Panel => p !== null);
  const gone = Array.isArray(r.gone) ? r.gone.slice(-MAX_GONE).map((p) => readPanel(p, ctx, pids)).filter((p): p is Panel => p !== null) : [];
  const values: Record<string, Value> = {};
  if (r.values && typeof r.values === "object") {
    for (const [k, v] of Object.entries(r.values as Record<string, unknown>).slice(0, 400)) {
      if (/^[A-Za-z][\w.-]{0,39}$/.test(k) && JSON.stringify(v ?? null).length <= 100_000) values[k] = v as Value;
    }
  }
  const focus = typeof r.focus === "string" && sids.has(r.focus) ? r.focus : null;
  return { version: 1, name: str(r.name, "Canvas", 80) || "Canvas", panels, surfaces, values, focus, gone };
}

// --------------------------------------------------------------- describing --

const show = (v: Value | undefined): string => {
  if (v === undefined) return "unset";
  const s = JSON.stringify(v);
  return s.length > 80 ? `${s.slice(0, 77)}…` : s;
};

/** The canvas in words, for the agent: what is on it, what each panel is and is bound to, and every value that is not its default. */
export function describeCanvas(canvas: Canvas, opts: { trees?: boolean } = {}): string {
  const lines: string[] = [`Canvas "${canvas.name}": ${canvas.surfaces.length} surface${canvas.surfaces.length === 1 ? "" : "s"}, ${canvas.panels.length} panel${canvas.panels.length === 1 ? "" : "s"}${canvas.focus ? `; the person is working on ${canvas.focus}` : ""}.`];
  for (const s of canvas.surfaces) {
    const changed = paramsOf(s.kind, s.table)
      .filter((p) => JSON.stringify(s.params[p.name]) !== JSON.stringify(p.default))
      .map((p) => `${p.name}=${show(s.params[p.name])}`);
    lines.push(`- surface ${s.id}: ${KINDS[s.kind].describe(s)} at ${s.x},${s.y} ${s.w}x${s.h}. ${changed.length ? `Set: ${changed.join(", ")}.` : "Untouched."}`);
  }
  for (const p of canvas.panels) {
    const flags = [p.state !== "live" ? p.state : "", p.pinned ? "pinned" : "", p.group ? `group ${p.group}` : "", p.by === "person" ? "placed by the person" : "", holdsWords(p.tree) ? (p.writes === "agent" ? "you may write in it" : "its words are the person's") : ""].filter(Boolean).join(", ");
    lines.push(`- panel ${p.id} "${p.title}"${p.recipe ? ` (recipe ${p.recipe})` : ""} on ${p.context} at ${p.x},${p.y} w${p.w}${flags ? ` [${flags}]` : ""}${p.why ? ` -- why: ${p.why}` : ""}${opts.trees ? `\n    ${treeWords(p.tree)}` : ""}`);
  }
  const shared = Object.entries(canvas.values);
  if (shared.length) lines.push(`Shared values: ${shared.slice(0, 40).map(([k, v]) => `${k}=${show(v)}`).join(", ")}.`);
  if (canvas.gone.length) lines.push(`Faded lately (the person can bring back): ${canvas.gone.map((g) => `${g.id} "${g.title}"`).join(", ")}.`);
  return lines.join("\n");
}
