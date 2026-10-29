/**
 * Panacea's local rules: what appears without a model call, at once.
 *
 *   - A surface arrives (a photo dropped, a table pasted): the panels that work always open beside it, and one more is
 *     offered as a ghost.
 *   - A value goes somewhere telling (exposure pushed far, a photo turned black and white, a table filtered to one
 *     category): the panel that helps next is offered as a ghost, with its reason, unless the person has waved it away
 *     before.
 *
 * The agent does the rest (composing, rearranging, suggesting from what the person asks and does); these are the
 * reflexes. Shared by the server (when the agent adds a surface) and the page (when the person does), so the same
 * thing happens either way. Pure.
 */
import type { Value } from "./atoms";
import { MASK_PARAMS, newImageDoc, runImageCommand, selectionOf, type CommandResult, type PixelEnv } from "./image";
import { contextOf, estimateHeight, fade, MAX_SURFACES, nearestFree, placeFor, refocus, seedValues, snap, surfaceParams, uid, type Canvas, type Panel, type PanelState, type Side, type Surface, type Who } from "./canvas";
import { instantiate, type Recipe } from "./library";
import { bindsOf, checkTree, parseBind, surfacesOf, type Node } from "./recipe";
import { commandsOf, distinct, paramsOf, type Table } from "./surfaces";

interface PlaceOptions {
  near?: string | null;
  state?: PanelState;
  why: string;
  by: Who;
  side?: Side;
  view?: { x: number; y: number; w: number; h: number };
  id?: string;
  title?: string;
  w?: number;
  at?: { x: number; y: number };
  values?: Record<string, Value>;
}

/** The surface a panel near `near` works on: `near` itself, the surface a panel near it works on, or the focus. */
function surfaceNear(canvas: Canvas, near: string | null | undefined, kind: Surface["kind"]): string | null {
  const s = canvas.surfaces.find((x) => x.id === near && x.kind === kind);
  if (s) return s.id;
  const p = canvas.panels.find((x) => x.id === near);
  const viaPanel = p ? canvas.surfaces.find((x) => x.id === p.context && x.kind === kind) : undefined;
  if (viaPanel) return viaPanel.id;
  const focus = canvas.surfaces.find((x) => x.id === canvas.focus && x.kind === kind);
  return focus?.id ?? canvas.surfaces.filter((x) => x.kind === kind).at(-1)?.id ?? null;
}

/** The context a tree belongs to: the one surface it works on, or "general". */
function contextFor(tree: Node, canvas: Canvas): string {
  const real = surfacesOf(tree).filter((s) => canvas.surfaces.some((x) => x.id === s));
  return real.length === 1 ? real[0]! : "general";
}

/** Put a checked tree on the canvas as a panel. */
function placeTree(canvas: Canvas, tree: Node, title: string, w: number, opts: PlaceOptions, recipe?: string): Panel {
  // A ghost or a draft carries its reason and its buttons under it.
  const h = estimateHeight(tree, w) + (opts.state === "ghost" || opts.state === "draft" ? 72 : 0);
  const context = contextFor(tree, canvas);
  const near = opts.near ?? (context !== "general" ? context : null);
  const at = opts.at ?? placeFor(canvas, w, h, near, opts.side, opts.view);
  const panel: Panel = {
    id: opts.id ?? uid("p"),
    title: (opts.title ?? title).slice(0, 60),
    tree,
    ...(recipe ? { recipe } : {}),
    x: at.x, y: at.y, w, h: 0,
    state: opts.state ?? "live",
    context,
    why: opts.why.slice(0, 240),
    by: opts.by,
    at: Date.now(),
  };
  for (const [k, v] of Object.entries(opts.values ?? {})) if (canvas.values[k] === undefined) canvas.values[k] = v;
  seedValues(canvas, tree);
  canvas.panels.push(panel);
  return panel;
}

/** Put a library recipe on the canvas, made ready for it. Says why not when it does not fit. */
export function placeRecipe(canvas: Canvas, recipe: Recipe, opts: PlaceOptions): Panel | { error: string } {
  const ctx = contextOf(canvas, surfaceNear(canvas, opts.near, "image"), surfaceNear(canvas, opts.near, "data"));
  const made = instantiate(recipe, ctx);
  if ("error" in made) return made;
  return placeTree(canvas, made.tree, recipe.name, opts.w ?? recipe.w, { ...opts, values: { ...made.values, ...(opts.values ?? {}) } }, recipe.id);
}

/** Put an agent's own tree on the canvas, after the rulebook. */
export function placeComposed(canvas: Canvas, raw: unknown, title: string, w: number, opts: PlaceOptions): Panel | { error: string } {
  const ctx = contextOf(canvas, surfaceNear(canvas, opts.near, "image"), surfaceNear(canvas, opts.near, "data"));
  const checked = checkTree(raw, ctx);
  if (!checked.tree || checked.errors.length) return { error: checked.errors.join(" ") || "That is not a panel." };
  return placeTree(canvas, checked.tree, title, w, opts);
}

/** What opens by itself beside a surface that has just arrived: the panels, and one offered as a ghost. */
export function starters(surface: Surface): { live: string[]; ghost: string | null; why: string } {
  if (surface.kind === "image") {
    // The tools go last, so light and colour keep their places beside it whatever room is left for the tools.
    return { live: ["photo.light", "photo.colour", "photo.tools"], ghost: "photo.looks", why: "A photo arrived: light and colour, where most edits start, and its tools." };
  }
  const t = surface.table;
  const cols = t?.columns ?? [];
  const nums = cols.filter((c) => c.type === "number");
  const date = cols.find((c) => c.type === "date");
  const cats = cols.filter((c) => c.type === "text" && t && distinct(t, c.name, 13).length >= 2 && distinct(t, c.name, 13).length <= 12);
  const live: string[] = [];
  if (nums.length && date) live.push("data.line");
  else if (nums.length && cats.length) live.push("data.bar");
  if (cats.length) live.push("data.filter-category");
  return { live, ghost: nums.length ? "data.explore" : null, why: "A table arrived: a chart of it, and a filter for its categories." };
}

/** Lay out a new surface's starters: placed beside it, the person's way, skipping what they have waved away. */
function placeStarters(canvas: Canvas, surface: Surface, find: (id: string) => Recipe | undefined, opts: { side?: Side; quiet?: (id: string) => boolean; view?: PlaceOptions["view"] } = {}): Panel[] {
  const plan = starters(surface);
  const out: Panel[] = [];
  for (const id of plan.live) {
    const r = find(id);
    if (!r) continue;
    // The tools sit on the other side of the picture from the panels, as a tool bar does.
    const side: Side | undefined = id === "photo.tools" ? (opts.side === "left" ? "right" : "left") : opts.side;
    const p = placeRecipe(canvas, r, { near: surface.id, why: plan.why, by: "rule", side, view: opts.view });
    if (!("error" in p)) out.push(p);
  }
  if (plan.ghost && !opts.quiet?.(plan.ghost)) {
    const r = find(plan.ghost);
    const p = r ? placeRecipe(canvas, r, { near: surface.id, state: "ghost", why: `Offered: ${r.about}.`, by: "rule", side: opts.side, view: opts.view }) : null;
    if (p && !("error" in p)) out.push(p);
  }
  return out;
}

const has = (canvas: Canvas, recipe: string, surface: string) => canvas.panels.some((p) => p.recipe === recipe && p.context === surface);

/**
 * The person (or the agent) set a value: is there a panel worth offering for what they are doing now? One suggestion at
 * most, never one already on the canvas or waved away twice.
 */
export function suggestFor(canvas: Canvas, key: string, value: Value, quiet: (id: string) => boolean): { recipe: string; why: string; near: string } | null {
  const { surface, param } = parseBind(key);
  if (!surface) return null;
  const s = canvas.surfaces.find((x) => x.id === surface);
  if (!s) return null;
  const offer = (recipe: string, why: string) => (has(canvas, recipe, s.id) || quiet(recipe) ? null : { recipe, why, near: s.id });
  if (s.kind === "image") {
    if (param === "exposure" && typeof value === "number" && Math.abs(value) >= 1.2 && !has(canvas, "photo.curve", s.id)) {
      return offer("photo.histogram", "Exposure is pushed a long way: the histogram shows what is clipping.");
    }
    if (param === "saturation" && typeof value === "number" && value <= -90) return offer("photo.mono", "It is black and white now: contrast and grain carry it from here.");
    if (param === "aspect" && value !== "original" && value !== "free") return offer("photo.straighten", "Cropped: a level horizon matters more in a tight frame.");
    if (param === "look" && value !== "none") return offer("photo.compare", "A look is on: compare it with the original.");
  } else {
    if (param.startsWith("filter.") && Array.isArray(value) && value.length === 1) return offer("data.top", `Filtered to ${String(value[0])}: its top rows.`);
    if (param === "search" && typeof value === "string" && value.trim()) return offer("data.table", "Searching: the matching rows.");
  }
  return null;
}

export interface SurfaceInput {
  kind: "image" | "data";
  name: string;
  title?: string;
  artifact?: string;
  table?: Table;
  px?: { w: number; h: number } | null;
  /** Where it goes, when it was dropped somewhere; else beside what is there. */
  at?: { x: number; y: number };
}

/**
 * A file made a surface: laid out (where it was dropped, or beside what is there), made the focus, and given its
 * starter panels. The same whether the person dropped it or the agent added it.
 */
export function addSurfaceTo(canvas: Canvas, input: SurfaceInput, find: (id: string) => Recipe | undefined, opts: { side?: Side; quiet?: (id: string) => boolean; view?: PlaceOptions["view"] } = {}): { surface: Surface; panels: Panel[] } | { error: string } {
  if (canvas.surfaces.length >= MAX_SURFACES) return { error: `The canvas already has ${MAX_SURFACES} surfaces; remove one first.` };
  const w = input.kind === "image" ? 512 : 576;
  const h = input.kind === "image" && input.px && input.px.w > 0 ? snap(Math.min(720, Math.max(192, (w * input.px.h) / input.px.w))) : input.kind === "image" ? 384 : 352;
  // Room for the panels that come with it, to its right.
  // Where it was dropped if that is free, else the free spot nearest it; with room for its panels to the right.
  // A photo keeps room on its other side for its tools.
  const tools = input.kind === "image" ? 240 : 0;
  const spot = input.at ? nearestFree(canvas, w + 336 + tools, h, { x: input.at.x + 168, y: input.at.y }) : placeFor(canvas, w + 352 + tools, h, null, "right");
  const at = { x: spot.x + tools, y: spot.y };
  const surface: Surface = {
    id: uid(input.kind === "image" ? "img" : "dat"),
    kind: input.kind,
    title: (input.title ?? input.name.replace(/\.[a-z0-9]+$/i, "")).slice(0, 80) || (input.kind === "image" ? "Image" : "Table"),
    x: at.x, y: at.y, w, h,
    ...(input.artifact ? { artifact: input.artifact } : {}),
    name: input.name.slice(0, 200),
    params: surfaceParams({ kind: input.kind, table: input.table, image: input.kind === "image" ? newImageDoc() : null }),
    ...(input.kind === "image" ? { image: newImageDoc() } : {}),
    ...(input.table ? { table: input.table } : {}),
    ...(input.px ? { px: input.px } : {}),
  };
  canvas.surfaces.push(surface);
  refocus(canvas, surface.id);
  const panels = placeStarters(canvas, surface, find, opts);
  return { surface, panels };
}

// ---------------------------------------------------------------- commands --

const DEVELOP_KEEP = /^(tool|tool\..*|color|sel\..*|layer\..*|mask\..*|compare)$/;

/** A panel for one local adjustment: its own sliders, bound to `mask.<id>.*`. */
function maskPanel(surface: string, mask: { id: string; name: string }): Node {
  const b = (k: string) => `@${surface}.mask.${mask.id}.${k}`;
  const show = ["exposure", "contrast", "shadows", "temperature", "saturation"];
  return {
    atom: "group", props: { label: mask.name },
    children: [
      ...MASK_PARAMS.map((p): Node => ({ atom: "slider", bind: b(p.name), props: { label: p.label, ...(p.min! < 0 ? { centre: true } : {}) }, ...(show.includes(p.name) ? {} : { advanced: true }) })),
      { atom: "button", props: { label: "Delete adjustment", action: `@${surface}.mask.delete`, args: { id: mask.id } }, advanced: true },
    ],
  };
}

/** A panel for one text layer: its words, type and colour, bound to `layer.<id>.*`. */
function textPanel(surface: string, layer: string): Node {
  const b = (k: string) => `@${surface}.layer.${layer}.${k}`;
  return {
    atom: "stack",
    children: [
      { atom: "text", bind: b("text"), props: { label: "Words", multiline: true } },
      { atom: "slider", bind: b("size"), props: { label: "Size" } },
      { atom: "color", bind: b("color"), props: { label: "Colour" } },
      { atom: "select", bind: b("font"), props: { label: "Font" } },
      { atom: "toggle", bind: b("bold"), props: { label: "Bold" } },
      { atom: "segmented", bind: b("align"), props: { label: "Align" } },
      { atom: "toggle", bind: b("shadow"), props: { label: "Shadow" }, advanced: true },
      { atom: "slider", bind: b("opacity"), props: { label: "Opacity" }, advanced: true },
      { atom: "slider", bind: b("angle"), props: { label: "Angle", centre: true }, advanced: true },
      { atom: "button", props: { label: "Delete layer", action: `@${surface}.layer.delete`, args: { id: layer } }, advanced: true },
    ],
  };
}

/** Panels whose binds name a layer or an adjustment that is gone go with it. */
function dropOrphans(canvas: Canvas, surface: string) {
  const s = canvas.surfaces.find((x) => x.id === surface);
  if (!s) return;
  const names = new Set(paramsOf(s).map((p) => `@${s.id}.${p.name}`));
  const orphan = (tree: Node) => bindsOf(tree).some((b) => b.startsWith(`@${s.id}.`) && !names.has(b));
  canvas.panels = canvas.panels.filter((p) => !orphan(p.tree));
  canvas.gone = canvas.gone.filter((p) => !orphan(p.tree));
}

const hasRecipe = (canvas: Canvas, recipe: string, surface: string) => canvas.panels.some((p) => p.recipe === recipe && p.context === surface && p.state !== "ghost");

export type RunResult = CommandResult & { panels?: string[] };

/**
 * Run a surface's command on the canvas, and bring the controls its result needs, or put away the ones it no longer
 * does: a selection made brings the Selection panel and deselecting puts it away; a local adjustment brings its own
 * sliders; a new layer brings Layers; text brings its words and type. The same for the person and the agent.
 * `export` and `auto` read the picture, so the window runs those itself.
 */
export function runCommand(canvas: Canvas, surfaceId: string, name: string, args: Record<string, unknown>, find: (id: string) => Recipe | undefined, opts: { by: Who; side?: Side; env?: PixelEnv } ): RunResult {
  const s = canvas.surfaces.find((x) => x.id === surfaceId);
  if (!s) return { ok: false, error: `There is no surface "${surfaceId}".` };
  if (!commandsOf(s).some((c) => c.name === name)) return { ok: false, error: `${s.title} has no command "${name}". It has: ${commandsOf(s).map((c) => c.name).join(", ")}.` };
  if (name === "reset" || name === "clear") {
    const fresh = surfaceParams(s);
    for (const [k, v] of Object.entries(fresh)) if (name === "reset" ? !DEVELOP_KEEP.test(k) : k.startsWith("filter.") || k === "search") s.params[k] = v;
    return { ok: true, said: name === "reset" ? `Reset ${s.title}'s adjustments (its layers stay).` : `Cleared the filters on ${s.title}.` };
  }
  if (s.kind !== "image") return { ok: false, error: `${name} is done by the window.`, window: true };
  s.image ??= newImageDoc();
  const had = selectionOf(s.image, s.params) !== null;
  const r = runImageCommand({ image: s.image, params: s.params, px: s.px }, name, args, opts.env);
  if (!r.ok) return r;
  const placed: string[] = [];
  const place = (tree: Node | Recipe, title: string, why: string) => {
    const p = "tree" in tree
      ? placeRecipe(canvas, tree, { near: s.id, why, by: opts.by, side: opts.side })
      : placeComposed(canvas, tree, title, 288, { near: s.id, why, by: opts.by, side: opts.side });
    if (!("error" in p)) placed.push(p.id);
  };
  // New values (a layer's, an adjustment's) start at their defaults unless the command set them.
  for (const p of paramsOf(s)) if (s.params[p.name] === undefined) s.params[p.name] = p.default;
  dropOrphans(canvas, s.id);
  const has = selectionOf(s.image, s.params) !== null;
  if (has && !had && !hasRecipe(canvas, "photo.selection", s.id)) { const rec = find("photo.selection"); if (rec) place(rec, rec.name, "Something is selected: what you can do with it."); }
  if (!has && had) for (const p of canvas.panels.filter((x) => x.recipe === "photo.selection" && x.context === s.id && !x.pinned)) fade(canvas, p.id);
  if (r.mask) { const m = s.image.masks.find((x) => x.id === r.mask); if (m) place(maskPanel(s.id, m), m.name, `Sliders for ${m.name} only: the rest of the picture stays as it is.`); }
  if (r.layer) {
    const l = s.image.layers.find((x) => x.id === r.layer);
    if (l?.kind === "text") place(textPanel(s.id, l.id), `Text: ${l.name}`, "The words, their type and colour.");
    if (!hasRecipe(canvas, "photo.layers", s.id)) { const rec = find("photo.layers"); if (rec) place(rec, rec.name, "The picture has layers now: show, hide, reorder or delete them here."); }
  }
  return { ...r, ...(placed.length ? { panels: placed } : {}) };
}
