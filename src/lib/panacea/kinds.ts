/**
 * Surface kinds: every kind of work that can sit on Panacea's canvas, and everything that is particular to each.
 *
 * A kind is one entry in `KINDS`. It says what the work publishes (parameters, actions), what opens beside it when it
 * arrives (starters), what is worth offering when a value goes somewhere telling (suggest), how it reads in words for
 * the agent and in the surface's title bar, how big it first is, and which part of the library its learned panels are
 * filed under. Nothing else in the model asks `kind === "image"`: it asks the registry, so a new kind is a new entry here
 * and the compiler names the places that still have to learn about it (the window's view of it, the server's adapter).
 * The design and the plan are in docs/PANACEA-ENGINE.md.
 *
 * Shared by the server and the page, so written without DOM or Node types.
 */
import type { Value } from "./atoms";
import type { Surface } from "./canvas";
import type { Domain } from "./library";
import {
  DATA_ACTIONS, IMAGE_ACTIONS, IMAGE_PARAMS, dataParams, distinct, normalizeTable,
  type ActionSpec, type ParamSpec, type Table,
} from "./surfaces";

/** What opens by itself beside a surface that has just arrived: the panels, and one offered as a ghost. */
export interface Starters {
  live: string[];
  ghost: string | null;
  why: string;
}

/** A panel worth offering, and why. */
export interface Offer {
  recipe: string;
  why: string;
}

/** What a kind's `suggest` is given to judge with: whether a recipe is already beside the surface, and how to offer one. */
interface OfferTools {
  has: (recipe: string) => boolean;
  offer: (recipe: string, why: string) => Offer | null;
}

interface SurfaceKindDef {
  /** The start of its surfaces' ids ("img" for img1k3). */
  prefix: string;
  /** The part of the library its learned panels are filed under. */
  domain: Domain;
  /** What a person calls one ("a photo"). */
  noun: string;
  /** What a surface of this kind is called when its file gives no name. */
  title: string;
  /** What it lets a control change; the table's depend on its columns. */
  params: (table?: Table | null) => ParamSpec[];
  actions: ActionSpec[];
  /** How big it is when it arrives, before it is snapped to the grid; `px` is the picture's own size, when it has one. */
  size: (px?: { w: number; h: number } | null) => { w: number; h: number };
  starters: (surface: Surface) => Starters;
  /** One panel worth offering now that `param` has gone to `value`, or null. */
  suggest: (surface: Surface, param: string, value: Value, tools: OfferTools) => Offer | null;
  /** The surface in a line of words for the agent. */
  describe: (surface: Surface) => string;
  /** The small print in its title bar. */
  meta: (surface: Surface) => string;
  /** What a saved surface carries beyond the fields every kind has, read and checked; null when it cannot be read. */
  read: (raw: Record<string, unknown>) => { table?: Table } | null;
}

const IMAGE: SurfaceKindDef = {
  prefix: "img",
  domain: "photo",
  noun: "a photo",
  title: "Image",
  params: () => IMAGE_PARAMS,
  actions: IMAGE_ACTIONS,
  size: (px) => {
    const w = 512;
    return { w, h: px && px.w > 0 ? Math.min(720, Math.max(192, (w * px.h) / px.w)) : 384 };
  },
  starters: () => ({ live: ["photo.light", "photo.colour"], ghost: "photo.looks", why: "A photo arrived: light and colour are where most edits start." }),
  suggest: (_s, param, value, { has, offer }) => {
    if (param === "exposure" && typeof value === "number" && Math.abs(value) >= 1.2 && !has("photo.curve")) {
      return offer("photo.histogram", "Exposure is pushed a long way: the histogram shows what is clipping.");
    }
    if (param === "saturation" && typeof value === "number" && value <= -90) return offer("photo.mono", "It is black and white now: contrast and grain carry it from here.");
    if (param === "aspect" && value !== "original" && value !== "free") return offer("photo.straighten", "Cropped: a level horizon matters more in a tight frame.");
    if (param === "look" && value !== "none") return offer("photo.compare", "A look is on: compare it with the original.");
    return null;
  },
  describe: (s) => `image "${s.title}"${s.px ? ` ${s.px.w}x${s.px.h}` : ""}${s.artifact ? ` (artifact ${s.artifact})` : ""}`,
  meta: (s) => (s.px ? `${s.px.w} × ${s.px.h}` : "Photo"),
  read: () => ({}),
};

const DATA: SurfaceKindDef = {
  prefix: "dat",
  domain: "data",
  noun: "a table",
  title: "Table",
  params: (table) => dataParams(table ?? { columns: [], rows: [] }),
  actions: DATA_ACTIONS,
  size: () => ({ w: 576, h: 352 }),
  starters: (surface) => {
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
  },
  suggest: (_s, param, value, { offer }) => {
    if (param.startsWith("filter.") && Array.isArray(value) && value.length === 1) return offer("data.top", `Filtered to ${String(value[0])}: its top rows.`);
    if (param === "search" && typeof value === "string" && value.trim()) return offer("data.table", "Searching: the matching rows.");
    return null;
  },
  describe: (s) => `data "${s.title}", ${s.table?.rows.length ?? 0} rows; columns ${s.table?.columns.map((c) => `${c.name} (${c.type})`).join(", ")}`,
  meta: (s) => `${s.table?.rows.length.toLocaleString() ?? 0} rows`,
  read: (raw) => {
    const table = normalizeTable(raw.table);
    return table ? { table } : null;
  },
};

/** Every kind there is. Adding one here widens `SurfaceKind`, and the compiler lists what else has to learn of it. */
export const KINDS = { image: IMAGE, data: DATA } as const satisfies Record<string, SurfaceKindDef>;

export type SurfaceKind = keyof typeof KINDS;

export const KIND_NAMES = Object.keys(KINDS) as SurfaceKind[];

export const isKind = (v: unknown): v is SurfaceKind => typeof v === "string" && Object.hasOwn(KINDS, v);

/** "an image", "a data": a kind named in a sentence. */
export const withArticle = (kind: SurfaceKind): string => `${/^[aeiou]/.test(kind) ? "an" : "a"} ${kind}`;

/** What a surface of a kind lets a control change. */
export function paramsOf(kind: SurfaceKind, table?: Table | null): ParamSpec[] {
  return KINDS[kind].params(table);
}

export function actionsOf(kind: SurfaceKind): ActionSpec[] {
  return KINDS[kind].actions;
}

/** The parameter a name refers to on a surface, if it declares one. */
export function findParam(kind: SurfaceKind, table: Table | null | undefined, name: string): ParamSpec | null {
  return paramsOf(kind, table).find((p) => p.name === name) ?? null;
}
