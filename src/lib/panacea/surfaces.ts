/**
 * Surfaces: the things on Panacea's canvas that controls work on, and the contract every one of them keeps.
 *
 * A surface is the work itself (a photo, a table, and later a PDF page, a video, a 3D model, a game scene): it is
 * drawn on the canvas, and it publishes a manifest of what can be changed about it (`params`, each with a kind and a
 * range) and what can be done to it (`actions`). A control in a panel binds to a parameter by name ("@img1.exposure"),
 * and the agent composes against the manifest: a recipe that binds to a parameter a surface does not declare, or with
 * a control of the wrong kind, is refused (src/lib/panacea/recipe.ts). That is what keeps generated UI honest: it can
 * only reach what a surface says it has.
 *
 * This file holds what the image and the table each publish (their parameters, actions and the table's reading and
 * filtering). Which kinds exist, and how each is told apart, is the registry in kinds.ts; a new kind joins there
 * (docs/PANACEA-ENGINE.md).
 *
 * Shared by the server and the page, so written without DOM or Node types.
 */
import type { Value, ValueKind } from "./atoms";

export interface ParamSpec {
  name: string;
  kind: ValueKind;
  /** What a person calls it, for the agent's index and the summon picker. */
  label: string;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  /** For a choice: what it may be. */
  options?: string[];
  default: Value;
  /** A setting most people never need: a panel keeps it behind More until the person has used it a few times. */
  advanced?: boolean;
  /** Worked out from the work (a word count), shown but never set. */
  derived?: boolean;
}

export interface ActionSpec {
  name: string;
  label: string;
  about: string;
}

export interface Column {
  name: string;
  type: "number" | "text" | "date";
}

/** A table, as a data surface holds it: typed columns and rows of cells. */
export interface Table {
  columns: Column[];
  rows: Array<Array<string | number | null>>;
}

const MAX_ROWS = 20_000;
const MAX_COLUMNS = 60;

/** The looks a photo can take: each is a set of the image's own parameters, so after picking one every slider is still theirs. */
export const LOOKS: Record<string, { label: string; swatch: string; set: Record<string, number> }> = {
  none: { label: "Original", swatch: "#8a8f99", set: {} },
  warm: { label: "Warm", swatch: "#e8a15a", set: { temperature: 28, tint: 4, vibrance: 12 } },
  cool: { label: "Cool", swatch: "#6aa6e8", set: { temperature: -26, tint: -3, vibrance: 8 } },
  film: { label: "Film", swatch: "#c9a27a", set: { contrast: -10, fade: 22, grain: 18, saturation: -12, temperature: 8 } },
  punch: { label: "Punch", swatch: "#e2574c", set: { contrast: 24, vibrance: 26, clarity: 18, blacks: -10 } },
  matte: { label: "Matte", swatch: "#9b8fa8", set: { fade: 32, contrast: -18, saturation: -8 } },
  mono: { label: "Mono", swatch: "#5d5d5d", set: { saturation: -100, contrast: 14, clarity: 10 } },
  noir: { label: "Noir", swatch: "#1f1f24", set: { saturation: -100, contrast: 42, blacks: -24, vignette: 38 } },
  golden: { label: "Golden hour", swatch: "#f0b14a", set: { temperature: 38, exposure: 0.15, highlights: -18, vibrance: 16 } },
  teal: { label: "Teal & orange", swatch: "#2f9c95", set: { temperature: 10, tint: -12, saturation: 10, contrast: 12 } },
  soft: { label: "Soft", swatch: "#f2c6c2", set: { contrast: -16, highlights: -10, clarity: -20, fade: 10 } },
  vivid: { label: "Vivid", swatch: "#41b883", set: { vibrance: 40, saturation: 12, contrast: 10 } },
};

const ASPECTS = ["free", "original", "1:1", "4:5", "3:2", "16:9", "9:16"] as const;

const num = (name: string, label: string, min: number, max: number, extra: Partial<ParamSpec> = {}): ParamSpec =>
  ({ name, kind: "number", label, min, max, step: extra.step ?? 1, default: 0, ...extra });

/** Everything an image surface lets a control change. Each is applied live on the GPU (src/components/panacea/imagegl.ts). */
export const IMAGE_PARAMS: ParamSpec[] = [
  num("exposure", "Exposure", -3, 3, { step: 0.05, unit: "EV" }),
  num("contrast", "Contrast", -100, 100),
  num("highlights", "Highlights", -100, 100),
  num("shadows", "Shadows", -100, 100),
  num("whites", "Whites", -100, 100, { advanced: true }),
  num("blacks", "Blacks", -100, 100, { advanced: true }),
  num("temperature", "Temperature", -100, 100),
  num("tint", "Tint", -100, 100),
  num("vibrance", "Vibrance", -100, 100),
  num("saturation", "Saturation", -100, 100),
  num("clarity", "Clarity", -100, 100, { advanced: true }),
  num("fade", "Fade", 0, 100, { advanced: true }),
  num("vignette", "Vignette", 0, 100, { advanced: true }),
  num("grain", "Grain", 0, 100, { advanced: true }),
  { name: "curve", kind: "points", label: "Tone curve", default: [[0, 0], [1, 1]] },
  { name: "look", kind: "choice", label: "Look", options: Object.keys(LOOKS), default: "none" },
  num("look_amount", "Look strength", 0, 100, { default: 100 }),
  { name: "aspect", kind: "choice", label: "Aspect", options: [...ASPECTS], default: "original" },
  num("straighten", "Straighten", -45, 45, { step: 0.5, unit: "°" }),
  { name: "rotate", kind: "choice", label: "Rotate", options: ["0", "90", "180", "270"], default: "0" },
  { name: "flip_h", kind: "bool", label: "Flip horizontal", default: false },
  { name: "flip_v", kind: "bool", label: "Flip vertical", default: false },
  num("zoom", "Crop zoom", 1, 4, { step: 0.05, default: 1, advanced: true }),
  { name: "compare", kind: "bool", label: "Before / after", default: false },
];

export const IMAGE_ACTIONS: ActionSpec[] = [
  { name: "reset", label: "Reset", about: "every adjustment back to the original" },
  { name: "auto", label: "Auto", about: "exposure, contrast and white balance worked out from the picture" },
  { name: "export", label: "Export", about: "the edited picture saved to the project as a PNG" },
];

/** A data surface's parameters depend on its columns: a filter per column, a sort, a row limit. */
export function dataParams(table: Table): ParamSpec[] {
  const out: ParamSpec[] = [];
  for (const c of table.columns) {
    if (c.type === "number") {
      const [lo, hi] = numericRange(table, c.name);
      out.push({ name: `filter.${c.name}`, kind: "pair", label: `${c.name} between`, min: lo, max: hi, step: niceStep(lo, hi), default: [lo, hi] });
    } else {
      const options = distinct(table, c.name, 200);
      out.push({ name: `filter.${c.name}`, kind: "choices", label: `${c.name} is`, options, default: [] });
    }
  }
  out.push({ name: "sort", kind: "choice", label: "Sort by", options: ["", ...table.columns.map((c) => c.name)], default: "" });
  out.push({ name: "descending", kind: "bool", label: "Largest first", default: true });
  out.push({ name: "search", kind: "text", label: "Search rows", default: "" });
  return out;
}

export const DATA_ACTIONS: ActionSpec[] = [
  { name: "export", label: "Export CSV", about: "the rows as filtered, saved to the project as a CSV" },
  { name: "clear", label: "Clear filters", about: "every filter off" },
];

// ---------------------------------------------------------------- tables --

function numericRange(table: Table, column: string): [number, number] {
  const i = table.columns.findIndex((c) => c.name === column);
  let lo = Infinity;
  let hi = -Infinity;
  if (i >= 0) for (const r of table.rows) { const v = r[i]; if (typeof v === "number") { lo = Math.min(lo, v); hi = Math.max(hi, v); } }
  return Number.isFinite(lo) ? [lo, hi] : [0, 1];
}

/** A step that gives a slider about a hundred positions across a range, rounded to a 1, 2 or 5. */
function niceStep(lo: number, hi: number): number {
  const raw = Math.abs(hi - lo) / 100 || 1;
  const p = 10 ** Math.floor(Math.log10(raw));
  const m = raw / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}

export function distinct(table: Table, column: string, cap: number): string[] {
  const i = table.columns.findIndex((c) => c.name === column);
  const seen = new Set<string>();
  if (i >= 0) for (const r of table.rows) { const v = r[i]; if (v !== null && v !== "") seen.add(String(v)); if (seen.size >= cap) break; }
  return [...seen];
}

/** The rows a data surface shows after its filters, search and sort: what every chart and table of it draws. */
export function filteredRows(table: Table, params: Record<string, Value>): Table["rows"] {
  const tests: Array<(r: Table["rows"][number]) => boolean> = [];
  table.columns.forEach((c, i) => {
    const f = params[`filter.${c.name}`];
    if (c.type === "number" && Array.isArray(f) && f.length === 2 && typeof f[0] === "number" && typeof f[1] === "number") {
      const [lo, hi] = f as [number, number];
      const [min, max] = numericRange(table, c.name);
      if (lo > min || hi < max) tests.push((r) => typeof r[i] === "number" && (r[i] as number) >= lo && (r[i] as number) <= hi);
    } else if (c.type !== "number" && Array.isArray(f) && f.length > 0) {
      const set = new Set((f as unknown[]).map(String));
      tests.push((r) => set.has(String(r[i] ?? "")));
    }
  });
  const search = typeof params.search === "string" ? params.search.trim().toLowerCase() : "";
  if (search) tests.push((r) => r.some((v) => v !== null && String(v).toLowerCase().includes(search)));
  let rows = tests.length ? table.rows.filter((r) => tests.every((t) => t(r))) : table.rows.slice();
  const sort = typeof params.sort === "string" ? table.columns.findIndex((c) => c.name === params.sort) : -1;
  if (sort >= 0) {
    const down = params.descending !== false;
    rows = rows.sort((a, b) => {
      const x = a[sort];
      const y = b[sort];
      const cmp = typeof x === "number" && typeof y === "number" ? x - y : String(x ?? "").localeCompare(String(y ?? ""));
      return down ? -cmp : cmp;
    });
  }
  return rows;
}

/** Rows grouped by a column and a measure of others, for a chart. */
export function aggregate(table: Table, rows: Table["rows"], x: string, ys: string[], agg: string): { labels: string[]; series: Array<{ name: string; values: number[] }> } {
  const xi = table.columns.findIndex((c) => c.name === x);
  const yis = ys.map((y) => table.columns.findIndex((c) => c.name === y)).filter((i) => i >= 0);
  const order: string[] = [];
  const groups = new Map<string, Table["rows"]>();
  for (const r of rows) {
    const k = xi >= 0 ? String(r[xi] ?? "") : "All";
    let g = groups.get(k);
    if (!g) { groups.set(k, (g = [])); order.push(k); }
    g.push(r);
  }
  // Numbers along x (years, sizes) read left to right in order; words keep the order they first appear in.
  if (xi >= 0 && table.columns[xi]!.type !== "text") order.sort((a, b) => (Number(a) - Number(b)) || a.localeCompare(b));
  const measure = (g: Table["rows"], i: number): number => {
    const vals = g.map((r) => r[i]).filter((v): v is number => typeof v === "number");
    switch (agg) {
      case "count": return g.length;
      case "mean": return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
      case "min": return vals.length ? Math.min(...vals) : 0;
      case "max": return vals.length ? Math.max(...vals) : 0;
      default: return vals.reduce((a, b) => a + b, 0);
    }
  };
  const series = (yis.length ? yis : [-1]).map((i) => ({
    name: i >= 0 ? table.columns[i]!.name : "Rows",
    values: order.map((k) => (i >= 0 ? measure(groups.get(k)!, i) : groups.get(k)!.length)),
  }));
  return { labels: order, series };
}

// ---------------------------------------------------------------- reading --

/** A cell as typed: a number when it reads as one (1,234.5 and 12% included), else trimmed text, or null when empty. */
function cell(raw: string): string | number | null {
  const t = raw.trim();
  if (t === "") return null;
  const n = t.replace(/,(?=\d{3}\b)/g, "").replace(/^\$|%$/g, "");
  if (/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(n)) return Number(n);
  return t.slice(0, 400);
}

/** Split CSV or TSV text (quoted fields, doubled quotes, CRLF) into rows of strings. Tabs win when the first line has more of them. */
export function splitDelimited(text: string): string[][] {
  const first = text.slice(0, text.indexOf("\n") >= 0 ? text.indexOf("\n") : text.length);
  const sep = (first.match(/\t/g)?.length ?? 0) > (first.match(/,/g)?.length ?? 0) ? "\t" : (first.match(/;/g)?.length ?? 0) > (first.match(/,/g)?.length ?? 0) ? ";" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === "\"" && text[i + 1] === "\"") { field += "\""; i++; }
      else if (ch === "\"") quoted = false;
      else field += ch;
    } else if (ch === "\"" && field === "") quoted = true;
    else if (ch === sep) { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
      if (rows.length > MAX_ROWS) break;
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f !== "")) rows.push(row);
  return rows;
}

/** Rows of strings, the first being the header, made a typed table: a column is a number when nearly all of its cells are. */
export function tableFrom(grid: string[][]): Table | null {
  if (grid.length < 2) return null;
  const width = Math.min(MAX_COLUMNS, Math.max(...grid.slice(0, 50).map((r) => r.length)));
  const used = new Set<string>();
  const names = Array.from({ length: width }, (_, i) => {
    let n = (grid[0]![i] ?? "").trim().slice(0, 60) || `Column ${i + 1}`;
    while (used.has(n)) n = `${n} 2`;
    used.add(n);
    return n;
  });
  const body = grid.slice(1, MAX_ROWS + 1).map((r) => Array.from({ length: width }, (_, i) => cell(r[i] ?? "")));
  const columns: Column[] = names.map((name, i) => {
    const vals = body.map((r) => r[i]).filter((v) => v !== null);
    const nums = vals.filter((v) => typeof v === "number").length;
    const dates = vals.filter((v) => typeof v === "string" && /^\d{4}-\d{2}(-\d{2})?/.test(v)).length;
    const type: Column["type"] = vals.length && nums / vals.length >= 0.9 ? "number" : vals.length && dates / vals.length >= 0.9 ? "date" : "text";
    return { name, type };
  });
  // A column read as text keeps every cell as text, so "007" and "7" stay apart.
  const rows = body.map((r) => r.map((v, i) => (columns[i]!.type !== "number" && typeof v === "number" ? String(v) : columns[i]!.type === "number" && typeof v !== "number" ? null : v)));
  return { columns, rows };
}

/** A table from anywhere (a saved canvas, the page), checked and repaired; null when it is not one. */
export function normalizeTable(raw: unknown): Table | null {
  const t = raw as Table | undefined;
  if (!t || !Array.isArray(t.columns) || !Array.isArray(t.rows)) return null;
  const columns = t.columns.filter((c) => c && typeof c.name === "string").map((c) => ({ name: c.name.slice(0, 60), type: c.type === "number" || c.type === "date" ? c.type : "text" as const }));
  const rows = t.rows.filter(Array.isArray).slice(0, MAX_ROWS).map((row) => columns.map((_, i) => {
    const v = row[i];
    return typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" ? v.slice(0, 400) : null;
  }));
  return { columns, rows };
}

/** A table as CSV text. */
export function tableCsv(columns: Column[], rows: Table["rows"]): string {
  const q = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, "\"\"")}"` : s;
  };
  return [columns.map((c) => q(c.name)).join(","), ...rows.map((r) => r.map(q).join(","))].join("\n");
}
