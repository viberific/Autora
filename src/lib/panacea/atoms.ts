/**
 * Panacea's atoms: the smallest pieces a panel is built from.
 *
 * Every panel on the canvas is a tree of these, written by the agent (a recipe) or taken from the library. The atoms are
 * the rules the agent cannot step outside: a recipe names atoms from this list, with props this list allows, bound to
 * values a surface or the canvas declares (src/lib/panacea/recipe.ts checks all of it). Each atom is drawn natively by
 * the window (src/components/panacea/Atoms.tsx), so whatever the agent composes looks like the rest of Autora.
 *
 * Shared by the server and the page, so written without DOM or Node types.
 */

import type { SurfaceKind } from "./kinds";

/** What a bound control holds. */
export type Value = number | boolean | string | string[] | number[] | Array<[number, number]> | LaneItem[] | null;

/** One block on a `lanes` atom: a clip on a track, a scene in a sequence, a task on a day. */
export interface LaneItem {
  id: string;
  lane: number;
  start: number;
  length: number;
  label: string;
}

/** The kind of value an atom holds, which is also what a surface's parameter must be for the atom to bind to it. */
export type ValueKind = "number" | "bool" | "choice" | "choices" | "text" | "color" | "pair" | "points" | "list" | "steps" | "lanes";

export type AtomKind =
  // layout
  | "stack" | "row" | "group" | "divider"
  // display
  | "label" | "note" | "stat" | "meter" | "badge"
  // controls
  | "slider" | "knob" | "stepper" | "toggle" | "segmented" | "select" | "chips" | "swatches" | "color" | "text"
  | "range" | "xy" | "curve" | "button" | "list" | "pads" | "lanes"
  // views of a surface
  | "histogram" | "chart" | "table"
  // a bespoke piece: code the agent wrote with the person, run in a sandboxed frame
  | "bespoke";

/** The props an atom may carry, and what each must be. */
type PropKind = "text" | "number" | "bool" | "options" | "enum" | "column" | "columns" | "surface" | "html" | "binds";

interface PropSpec {
  kind: PropKind;
  /** For `enum`. */
  of?: readonly string[];
  /** For `number`: the range a value is clamped to. */
  min?: number;
  max?: number;
}

interface AtomSpec {
  kind: AtomKind;
  /** In a few words, for the library index the agent reads. */
  about: string;
  /** Layout atoms hold others; every other atom is a leaf. */
  container?: boolean;
  /** The value it holds when bound, or nothing for an atom that only shows. */
  value?: ValueKind;
  /** A control a person sets: counted against the calm limit (a panel shows at most MAX_VISIBLE_CONTROLS at once). */
  control?: boolean;
  /** For a view of a surface: the kind of surface it draws. */
  surfaceKind?: SurfaceKind;
  props: Record<string, PropSpec>;
}

const CHART_KINDS = ["bar", "line", "area", "pie", "scatter"] as const;
const AGGREGATES = ["sum", "mean", "count", "min", "max"] as const;

const label: PropSpec = { kind: "text" };
const unit: PropSpec = { kind: "text" };

/** The whole set. The order is the order the summon picker and the index list them in. */
export const ATOMS: Record<AtomKind, AtomSpec> = {
  stack: { kind: "stack", about: "children one under another", container: true, props: { gap: { kind: "number", min: 0, max: 32 } } },
  row: { kind: "row", about: "children side by side, wrapping when narrow", container: true, props: { gap: { kind: "number", min: 0, max: 32 } } },
  group: { kind: "group", about: "a titled section; its `advanced` children wait behind More", container: true, props: { label } },
  divider: { kind: "divider", about: "a hairline between sections", props: {} },

  label: { kind: "label", about: "a short heading", props: { text: { kind: "text" } } },
  note: { kind: "note", about: "a line of quiet explanatory text", props: { text: { kind: "text" } } },
  stat: { kind: "stat", about: "a big number with a caption, bound to a value", value: "number", props: { label, unit, decimals: { kind: "number", min: 0, max: 4 } } },
  meter: { kind: "meter", about: "a bar filled to a value between min and max", value: "number", props: { label, min: { kind: "number" }, max: { kind: "number" }, unit } },
  badge: { kind: "badge", about: "a small status word", value: "text", props: { label, tone: { kind: "enum", of: ["plain", "accent", "live", "warn", "danger"] } } },

  slider: {
    kind: "slider", about: "a number dragged along a track", value: "number", control: true,
    props: { label, min: { kind: "number" }, max: { kind: "number" }, step: { kind: "number", min: 0 }, unit, centre: { kind: "bool" } },
  },
  knob: { kind: "knob", about: "a number turned on a dial (compact)", value: "number", control: true, props: { label, min: { kind: "number" }, max: { kind: "number" }, step: { kind: "number", min: 0 }, unit } },
  stepper: { kind: "stepper", about: "a whole number with - and + buttons", value: "number", control: true, props: { label, min: { kind: "number" }, max: { kind: "number" }, step: { kind: "number", min: 0 }, unit } },
  toggle: { kind: "toggle", about: "on or off", value: "bool", control: true, props: { label } },
  segmented: { kind: "segmented", about: "one of 2-6 choices, all visible", value: "choice", control: true, props: { label, options: { kind: "options" } } },
  select: { kind: "select", about: "one of many choices, in a menu", value: "choice", control: true, props: { label, options: { kind: "options" } } },
  chips: { kind: "chips", about: "any number of choices, each a chip to switch on", value: "choices", control: true, props: { label, options: { kind: "options" } } },
  swatches: { kind: "swatches", about: "one of a row of coloured swatches (looks, palettes)", value: "choice", control: true, props: { label, options: { kind: "options" } } },
  color: { kind: "color", about: "a colour", value: "color", control: true, props: { label } },
  text: { kind: "text", about: "a line of text typed in", value: "text", control: true, props: { label, placeholder: { kind: "text" }, multiline: { kind: "bool" } } },
  range: { kind: "range", about: "a low and a high number on one track", value: "pair", control: true, props: { label, min: { kind: "number" }, max: { kind: "number" }, step: { kind: "number", min: 0 }, unit } },
  xy: { kind: "xy", about: "a point dragged on a square pad (two numbers -1..1)", value: "pair", control: true, props: { label, x: { kind: "text" }, y: { kind: "text" } } },
  curve: { kind: "curve", about: "a tone curve: points dragged on a square, 0..1 in and out", value: "points", control: true, props: { label } },
  button: {
    kind: "button", about: "an action: ask Autora, set a value, or a surface's action", control: true,
    props: { label, ask: { kind: "text" }, action: { kind: "text" }, tone: { kind: "enum", of: ["plain", "accent"] } },
  },
  list: { kind: "list", about: "an ordered list of short items the person can add to, reorder and tick", value: "list", control: true, props: { label, placeholder: { kind: "text" } } },
  pads: { kind: "pads", about: "a grid of steps to switch on (a drum pattern, a habit tracker)", value: "steps", control: true, props: { label, cols: { kind: "number", min: 2, max: 32 }, rows: { kind: "number", min: 1, max: 8 }, names: { kind: "options" } } },
  lanes: { kind: "lanes", about: "blocks on lanes along a ruler (a timeline, a schedule)", value: "lanes", control: true, props: { label, lanes: { kind: "options" }, length: { kind: "number", min: 1, max: 100000 }, unit } },

  histogram: { kind: "histogram", about: "the live histogram of an image surface", surfaceKind: "image", props: { surface: { kind: "surface" } } },
  chart: {
    kind: "chart", about: "a chart of a data surface's rows, after its filters", surfaceKind: "data",
    props: {
      surface: { kind: "surface" }, kind: { kind: "enum", of: CHART_KINDS }, x: { kind: "column" }, y: { kind: "columns" },
      agg: { kind: "enum", of: AGGREGATES }, label,
    },
  },
  table: { kind: "table", about: "the rows of a data surface, after its filters", surfaceKind: "data", props: { surface: { kind: "surface" }, columns: { kind: "columns" }, limit: { kind: "number", min: 1, max: 500 } } },

  bespoke: { kind: "bespoke", about: "a piece written for this need, run sandboxed; talks only through its binds", props: { html: { kind: "html" }, binds: { kind: "binds" }, height: { kind: "number", min: 60, max: 800 } } },
};

/** A panel shows no more than this many controls before More: no panel should be overwhelming to look at. */
export const MAX_VISIBLE_CONTROLS = 8;
/** And holds no more than this many atoms, More included. */
export const MAX_NODES = 48;
export const MAX_DEPTH = 5;
export const MAX_OPTIONS = 16;

/** Does a value fit a kind? Used for binds, for values the agent sets, and for values the page sends back. */
export function valueFits(kind: ValueKind, v: unknown): boolean {
  const num = (n: unknown) => typeof n === "number" && Number.isFinite(n);
  switch (kind) {
    case "number": return num(v);
    case "bool": return typeof v === "boolean";
    case "choice": case "text": return typeof v === "string" && v.length <= 4000;
    case "color": return typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v);
    case "choices": case "list": return Array.isArray(v) && v.length <= 200 && v.every((s) => typeof s === "string" && s.length <= 400);
    case "pair": return Array.isArray(v) && v.length === 2 && v.every(num);
    case "points": return Array.isArray(v) && v.length >= 2 && v.length <= 16 && v.every((p) => Array.isArray(p) && p.length === 2 && p.every((n) => num(n) && n >= 0 && n <= 1));
    case "steps": return Array.isArray(v) && v.length <= 256 && v.every((n) => n === 0 || n === 1);
    case "lanes": return Array.isArray(v) && v.length <= 200 && v.every((it) => it && typeof it === "object" && typeof (it as LaneItem).id === "string" && num((it as LaneItem).lane) && num((it as LaneItem).start) && num((it as LaneItem).length) && typeof (it as LaneItem).label === "string");
  }
}

/** The empty value of a kind: what a newly bound control starts at when nothing has set it. */
export function emptyValue(kind: ValueKind): Value {
  switch (kind) {
    case "number": return 0;
    case "bool": return false;
    case "choice": case "text": return "";
    case "color": return "#7c5cff";
    case "choices": case "list": return [];
    case "pair": return [0, 1];
    case "points": return [[0, 0], [1, 1]];
    case "steps": return [];
    case "lanes": return [];
  }
}
