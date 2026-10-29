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
import { contextOf, estimateHeight, MAX_SURFACES, nearestFree, placeFor, refocus, seedValues, snap, surfaceParams, uid, type Canvas, type Panel, type PanelState, type Side, type Surface, type Who } from "./canvas";
import { instantiate, type Recipe } from "./library";
import { checkTree, parseBind, type CheckContext, type Node } from "./recipe";
import { KINDS, KIND_NAMES, type Offer, type Starters, type SurfaceKind } from "./kinds";
import type { Table } from "./surfaces";

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
function surfaceNear(canvas: Canvas, near: string | null | undefined, kind: SurfaceKind): string | null {
  const s = canvas.surfaces.find((x) => x.id === near && x.kind === kind);
  if (s) return s.id;
  const p = canvas.panels.find((x) => x.id === near);
  const viaPanel = p ? canvas.surfaces.find((x) => x.id === p.context && x.kind === kind) : undefined;
  if (viaPanel) return viaPanel.id;
  const focus = canvas.surfaces.find((x) => x.id === canvas.focus && x.kind === kind);
  return focus?.id ?? canvas.surfaces.filter((x) => x.kind === kind).at(-1)?.id ?? null;
}

/** For each kind, the surface of it a placeholder bind near `near` means. */
const nearTo = (canvas: Canvas, near: string | null | undefined): NonNullable<CheckContext["near"]> =>
  Object.fromEntries(KIND_NAMES.map((k) => [k, surfaceNear(canvas, near, k)]));

/** The context a tree belongs to: the one surface it works on, or "general". */
function contextFor(tree: Node, canvas: Canvas): string {
  const found = new Set<string>();
  const walk = (n: Node) => {
    if (n.bind?.startsWith("@")) { const s = parseBind(n.bind).surface; if (s) found.add(s); }
    if (typeof n.props?.surface === "string") found.add(n.props.surface);
    n.children?.forEach(walk);
  };
  walk(tree);
  const real = [...found].filter((s) => canvas.surfaces.some((x) => x.id === s));
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
  const ctx = contextOf(canvas, nearTo(canvas, opts.near));
  const made = instantiate(recipe, ctx);
  if ("error" in made) return made;
  return placeTree(canvas, made.tree, recipe.name, opts.w ?? recipe.w, { ...opts, values: { ...made.values, ...(opts.values ?? {}) } }, recipe.id);
}

/** Put an agent's own tree on the canvas, after the rulebook. */
export function placeComposed(canvas: Canvas, raw: unknown, title: string, w: number, opts: PlaceOptions): Panel | { error: string } {
  const ctx = contextOf(canvas, nearTo(canvas, opts.near));
  const checked = checkTree(raw, ctx);
  if (!checked.tree || checked.errors.length) return { error: checked.errors.join(" ") || "That is not a panel." };
  return placeTree(canvas, checked.tree, title, w, opts);
}

/** What opens by itself beside a surface that has just arrived: the panels, and one offered as a ghost. */
export function starters(surface: Surface): Starters {
  return KINDS[surface.kind].starters(surface);
}

/** Lay out a new surface's starters: placed beside it, the person's way, skipping what they have waved away. */
function placeStarters(canvas: Canvas, surface: Surface, find: (id: string) => Recipe | undefined, opts: { side?: Side; quiet?: (id: string) => boolean; view?: PlaceOptions["view"] } = {}): Panel[] {
  const plan = starters(surface);
  const out: Panel[] = [];
  for (const id of plan.live) {
    const r = find(id);
    if (!r) continue;
    const p = placeRecipe(canvas, r, { near: surface.id, why: plan.why, by: "rule", side: opts.side, view: opts.view });
    if (!("error" in p)) out.push(p);
  }
  if (plan.ghost && !opts.quiet?.(plan.ghost)) {
    const r = find(plan.ghost);
    const p = r ? placeRecipe(canvas, r, { near: surface.id, state: "ghost", why: `Offered: ${r.about}.`, by: "rule", side: opts.side, view: opts.view }) : null;
    if (p && !("error" in p)) out.push(p);
  }
  return out;
}

/**
 * The person (or the agent) set a value: is there a panel worth offering for what they are doing now? One suggestion at
 * most, never one already on the canvas or waved away twice.
 */
export function suggestFor(canvas: Canvas, key: string, value: Value, quiet: (id: string) => boolean): (Offer & { near: string }) | null {
  const { surface, param } = parseBind(key);
  if (!surface) return null;
  const s = canvas.surfaces.find((x) => x.id === surface);
  if (!s) return null;
  const has = (recipe: string) => canvas.panels.some((p) => p.recipe === recipe && p.context === s.id);
  const offer = (recipe: string, why: string) => (has(recipe) || quiet(recipe) ? null : { recipe, why });
  const found = KINDS[s.kind].suggest(s, param, value, { has, offer });
  return found ? { ...found, near: s.id } : null;
}

export interface SurfaceInput {
  kind: SurfaceKind;
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
  const def = KINDS[input.kind];
  const size = def.size(input.px);
  const w = snap(size.w);
  const h = snap(size.h);
  // Room for the panels that come with it, to its right.
  // Where it was dropped if that is free, else the free spot nearest it; with room for its panels to the right.
  const spot = input.at ? nearestFree(canvas, w + 336, h, { x: input.at.x + 168, y: input.at.y }) : placeFor(canvas, w + 352, h, null, "right");
  const at = { x: spot.x, y: spot.y };
  const surface: Surface = {
    id: uid(def.prefix),
    kind: input.kind,
    title: (input.title ?? input.name.replace(/\.[a-z0-9]+$/i, "")).slice(0, 80) || def.title,
    x: at.x, y: at.y, w, h,
    ...(input.artifact ? { artifact: input.artifact } : {}),
    name: input.name.slice(0, 200),
    params: surfaceParams(input.kind, input.table),
    ...(input.table ? { table: input.table } : {}),
    ...(input.px ? { px: input.px } : {}),
  };
  canvas.surfaces.push(surface);
  refocus(canvas, surface.id);
  const panels = placeStarters(canvas, surface, find, opts);
  return { surface, panels };
}
