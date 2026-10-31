/**
 * Recipes: a panel as a tree of atoms, and the check every one passes before it reaches the canvas.
 *
 * The agent composes a panel by writing a tree (`Node`): layout atoms holding controls, each control bound to a value.
 * `checkTree` is the rulebook. It refuses an atom that does not exist, a prop of the wrong kind, a bind to a parameter
 * no surface declares (or a control of the wrong kind for it), a tree too deep or too big, and a panel with more than
 * MAX_VISIBLE_CONTROLS controls in view: the rest must be marked `advanced`, so they wait behind More. Numbers are
 * clamped and words trimmed rather than refused. What comes out is safe to draw and calm to look at.
 *
 * `fingerprint` names a tree's shape (atoms, binds, structure; not its words or values), so two recipes that are the
 * same panel with different labels are one entry in the library.
 *
 * Shared by the server and the page, so written without DOM or Node types.
 */
import { ATOMS, MAX_DEPTH, MAX_NODES, MAX_OPTIONS, MAX_VISIBLE_CONTROLS, type AtomKind, type ValueKind } from "./atoms";
import { actionsOf, findParam, isKind, paramsOf, withArticle, type SurfaceKind } from "./kinds";
import type { Table } from "./surfaces";

export interface Option {
  value: string;
  label: string;
  /** A swatch's colour. */
  color?: string;
}

export interface Node {
  atom: AtomKind;
  props?: Record<string, unknown>;
  /** The value it shows and sets: a shared canvas value ("budget") or a surface's parameter ("@img1.exposure"). */
  bind?: string;
  /** Wait behind More until the person opens it or has used it a few times. */
  advanced?: boolean;
  children?: Node[];
}

/** A hierarchy of reusable panels. Expansion produces only the existing native Node tree. */
export type RecipePart =
  | { recipe: string; advanced?: boolean }
  | { atom: "stack" | "row" | "group"; props?: Record<string, unknown>; advanced?: boolean; children: RecipePart[] };
export const MAX_RECIPE_PARTS = 32;

/** Read the composition wire format before expansion. Refuses cycles and unknown fields; never executes a prop. */
export function readRecipePart(raw: unknown): { part: RecipePart } | { error: string } {
  let count = 0;
  const ancestors = new Set<object>();
  let error = "";
  const fail = (text: string): null => { error ||= text; return null; };
  const walk = (value: unknown, depth: number, path: string): RecipePart | null => {
    if (++count > MAX_RECIPE_PARTS) return fail(`At most ${MAX_RECIPE_PARTS} recipe parts; split the panel.`);
    if (depth > MAX_DEPTH) return fail(`Recipe parts nested deeper than ${MAX_DEPTH}; flatten them.`);
    if (!value || typeof value !== "object" || Array.isArray(value)) return fail(`${path}: a part is a recipe reference or a layout object.`);
    if (ancestors.has(value)) return fail(`${path}: cyclic recipe parts are not allowed.`);
    const r = value as Record<string, unknown>;
    const ref = Object.hasOwn(r, "recipe");
    const allowed = ref ? ["recipe", "advanced"] : ["atom", "props", "advanced", "children"];
    const extra = Object.keys(r).find((key) => !allowed.includes(key));
    if (extra) return fail(`${path}: unknown field "${extra}" in ${ref ? "a recipe reference" : "a layout part"}.`);
    if (r.advanced !== undefined && typeof r.advanced !== "boolean") return fail(`${path}: advanced must be a boolean.`);
    if (ref) {
      if (typeof r.recipe !== "string" || !r.recipe.trim() || r.recipe.length > 80) return fail(`${path}: recipe must be a library id.`);
      return { recipe: r.recipe.trim(), ...(r.advanced === true ? { advanced: true } : {}) };
    }
    if (r.atom !== "stack" && r.atom !== "row" && r.atom !== "group") return fail(`${path}: a layout part uses stack, row or group.`);
    if (r.props !== undefined && (!r.props || typeof r.props !== "object" || Array.isArray(r.props))) return fail(`${path}: props must be an object.`);
    if (!Array.isArray(r.children) || !r.children.length) return fail(`${path}: a layout part needs children.`);
    if (r.children.length > MAX_RECIPE_PARTS) return fail(`${path}: at most ${MAX_RECIPE_PARTS} children.`);
    ancestors.add(value);
    const children: RecipePart[] = [];
    for (let i = 0; i < r.children.length; i++) {
      const child = walk(r.children[i], depth + 1, `${path}.children.${i + 1}`);
      if (!child) { ancestors.delete(value); return null; }
      children.push(child);
    }
    ancestors.delete(value);
    return { atom: r.atom, ...(r.props ? { props: r.props as Record<string, unknown> } : {}), ...(r.advanced === true ? { advanced: true } : {}), children };
  };
  const part = walk(raw, 0, "parts");
  return part ? { part } : { error: error || "Invalid recipe parts." };
}

/** What a tree is checked against: the surfaces on the canvas, and which one "@image" and "@data" mean here. */
export interface CheckContext {
  surfaces: Array<{ id: string; kind: SurfaceKind; table?: Table | null }>;
  /** The surface a placeholder bind ("@image.exposure", "@data.filter.Region") resolves to, per kind; else the first of that kind. */
  near?: Partial<Record<SurfaceKind, string | null>>;
  /** Repair what can be repaired and drop what cannot, instead of refusing: for a canvas read back from disk. */
  lenient?: boolean;
}

interface Checked {
  tree: Node | null;
  errors: string[];
  /** Controls in view (not advanced). */
  controls: number;
  /** Atoms in the tree. */
  nodes: number;
}

const SHARED_NAME = /^[A-Za-z][\w.-]{0,39}$/;

/** A prop that reads a shared value ("=data.chart") instead of saying it outright. */
export const isRef = (v: string) => v.startsWith("=") && SHARED_NAME.test(v.slice(1));

/** Which kinds a parameter of `param` kind can be shown and set by an atom holding `atom` kind. */
function compatible(atom: ValueKind, param: ValueKind): boolean {
  if (atom === param) return true;
  // A colour is text with a shape; a choice can be shown by a badge.
  return (atom === "text" && (param === "choice" || param === "color")) || (atom === "choice" && param === "text");
}

interface BindTarget {
  surface: string | null;
  param: string;
}

/** A bind split into the surface it names (null for a shared value) and the parameter or value name. */
export function parseBind(bind: string): BindTarget {
  if (!bind.startsWith("@")) return { surface: null, param: bind };
  const dot = bind.indexOf(".");
  return dot < 0 ? { surface: bind.slice(1), param: "" } : { surface: bind.slice(1, dot), param: bind.slice(dot + 1) };
}

/** A surface id, or the name of a kind ("image", "data") standing for the surface of that kind meant here. */
function resolveSurface(id: string, ctx: CheckContext): string | null {
  if (isKind(id)) return ctx.near?.[id] ?? ctx.surfaces.find((s) => s.kind === id)?.id ?? null;
  return ctx.surfaces.some((s) => s.id === id) ? id : null;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

function readOptions(raw: unknown, errors: string[], where: string): Option[] | string | undefined {
  if (raw === undefined) return undefined;
  // Options read off a surface when drawn: a column's values, an image's palette, the looks.
  if (typeof raw === "string") {
    if (/^(column:.{1,60}|columns|palette|looks)$/.test(raw)) return raw;
    errors.push(`${where}: options is a list, or "column:<name>", "columns", "palette" or "looks".`);
    return undefined;
  }
  if (!Array.isArray(raw)) { errors.push(`${where}: options must be a list.`); return undefined; }
  const out: Option[] = [];
  for (const o of raw.slice(0, MAX_OPTIONS)) {
    if (typeof o === "string" || typeof o === "number") out.push({ value: String(o).slice(0, 80), label: String(o).slice(0, 40) });
    else if (o && typeof o === "object" && (typeof (o as Option).value === "string" || typeof (o as Option).value === "number")) {
      const v = String((o as Option).value).slice(0, 80);
      const color = typeof (o as Option).color === "string" && /^#[0-9a-f]{6}$/i.test((o as Option).color!) ? (o as Option).color : undefined;
      out.push({ value: v, label: typeof (o as Option).label === "string" ? (o as Option).label.slice(0, 40) : v, ...(color ? { color } : {}) });
    }
  }
  if (raw.length > MAX_OPTIONS) errors.push(`${where}: at most ${MAX_OPTIONS} options; use a select with "column:<name>" for long lists.`);
  return out;
}

/** Check (and tidy) a tree. Never throws; what it could not take is in `errors`. */
export function checkTree(raw: unknown, ctx: CheckContext): Checked {
  const errors: string[] = [];
  let nodes = 0;
  let controls = 0;

  const walk = (n: unknown, depth: number, hidden: boolean, path: string): Node | null => {
    if (!n || typeof n !== "object" || Array.isArray(n)) { errors.push(`${path}: each node is an object like {"atom": "slider", ...}.`); return null; }
    const r = n as Record<string, unknown>;
    const atom = r.atom as AtomKind;
    const spec = typeof atom === "string" ? ATOMS[atom] : undefined;
    if (!spec) { errors.push(`${path}: "${String(r.atom)}" is not an atom. Atoms: ${Object.keys(ATOMS).join(", ")}.`); return null; }
    if (depth > MAX_DEPTH) { errors.push(`${path}: nested deeper than ${MAX_DEPTH}; flatten it.`); return null; }
    nodes += 1;
    if (nodes > MAX_NODES) { if (nodes === MAX_NODES + 1) errors.push(`More than ${MAX_NODES} atoms: split it into two panels.`); return null; }
    const where = `${path} (${atom})`;
    const out: Node = { atom };
    const advanced = r.advanced === true;
    if (advanced) out.advanced = true;
    const off = hidden || advanced;

    // Props: only the ones the atom has, each of its kind.
    const props: Record<string, unknown> = {};
    const given = r.props && typeof r.props === "object" && !Array.isArray(r.props) ? (r.props as Record<string, unknown>) : {};
    for (const [key, value] of Object.entries(given)) {
      const ps = spec.props[key];
      if (!ps) { if (!ctx.lenient) errors.push(`${where}: no prop "${key}". It takes: ${Object.keys(spec.props).join(", ") || "none"}.`); continue; }
      if (value === undefined || value === null) continue;
      switch (ps.kind) {
        case "text": {
          if (typeof value !== "string" && typeof value !== "number") { errors.push(`${where}: ${key} is text.`); break; }
          props[key] = String(value).slice(0, atom === "note" || key === "ask" ? 400 : 80);
          break;
        }
        case "number": {
          const v = typeof value === "number" ? value : Number(value);
          if (!Number.isFinite(v)) { errors.push(`${where}: ${key} is a number.`); break; }
          props[key] = clamp(v, ps.min ?? -1e12, ps.max ?? 1e12);
          break;
        }
        case "bool": props[key] = value === true; break;
        case "enum": {
          // "=name" reads it from a shared value, so a control elsewhere can switch it (a chart's kind from a segmented).
          if (typeof value === "string" && isRef(value)) { props[key] = value; break; }
          if (typeof value !== "string" || !ps.of!.includes(value)) { errors.push(`${where}: ${key} is one of ${ps.of!.join(", ")}, or "=<value name>".`); break; }
          props[key] = value;
          break;
        }
        case "options": {
          const opts = readOptions(value, errors, where);
          if (opts !== undefined) props[key] = opts;
          break;
        }
        case "surface": {
          const id = typeof value === "string" ? value.replace(/^@/, "") : "";
          const sid = resolveSurface(id, ctx);
          const want = spec.surfaceKind;
          const s = ctx.surfaces.find((x) => x.id === sid);
          if (!want || !s || s.kind !== want) { errors.push(`${where}: surface "${String(value)}" is not ${want ? withArticle(want) : "a"} surface on the canvas.`); break; }
          props[key] = s.id;
          break;
        }
        case "column": case "columns": {
          // "=name" follows a shared value, as an enum may.
          if (typeof value === "string" && isRef(value)) { props[key] = value; break; }
          const list = ps.kind === "column" ? [value] : Array.isArray(value) ? value : [value];
          const names = list.filter((c): c is string => typeof c === "string").map((c) => c.slice(0, 60));
          // No columns is a count of rows.
          if (ps.kind === "columns" && Array.isArray(value) && value.length === 0) { props[key] = []; break; }
          if (!names.length) { errors.push(`${where}: ${key} names ${ps.kind === "column" ? "a column" : "columns"}.`); break; }
          props[key] = ps.kind === "column" ? names[0] : names.slice(0, 8);
          break;
        }
        case "html": {
          if (typeof value !== "string" || !value.trim()) { errors.push(`${where}: html is the piece's markup.`); break; }
          if (value.length > 100_000) { errors.push(`${where}: html is over 100,000 characters.`); break; }
          props[key] = value;
          break;
        }
        case "binds": {
          const list = Array.isArray(value) ? value.filter((b): b is string => typeof b === "string").slice(0, 16) : [];
          const ok = list.map((b) => bindOk(b, null, ctx, where)).filter((b): b is string => b !== null);
          props[key] = ok;
          break;
        }
      }
    }

    // A view of a surface draws the one meant here when it names none.
    if (spec.surfaceKind && typeof props.surface !== "string") {
      const sid = resolveSurface(spec.surfaceKind, ctx);
      if (sid) props.surface = sid;
      else errors.push(`${where}: there is no ${spec.surfaceKind} surface to draw. Add one first (panacea_surface).`);
    }
    // The columns a chart or table names must be its surface's.
    if ((atom === "chart" || atom === "table") && typeof props.surface === "string") {
      const s = ctx.surfaces.find((x) => x.id === props.surface);
      const cols = new Set((s?.table?.columns ?? []).map((c) => c.name));
      for (const key of ["x", "y", "columns"]) {
        const v = props[key];
        const list = Array.isArray(v) ? v : typeof v === "string" ? [v] : [];
        const bad = list.filter((c) => typeof c === "string" && !isRef(c) && !cols.has(c));
        if (bad.length) {
          errors.push(`${where}: no column ${bad.map((b) => `"${b}"`).join(", ")}. Columns: ${[...cols].join(", ")}.`);
          if (ctx.lenient) delete props[key];
        }
      }
    }
    if (atom === "button" && typeof props.action === "string" && props.action) {
      const a = props.action as string;
      if (a.startsWith("@")) {
        const { surface, param } = parseBind(a);
        const sid = surface ? resolveSurface(surface, ctx) : null;
        const s = ctx.surfaces.find((x) => x.id === sid);
        if (!s || !actionsOf(s.kind).some((x) => x.name === param)) {
          errors.push(`${where}: action "${a}" is not a surface's action. ${s ? `It has: ${actionsOf(s.kind).map((x) => x.name).join(", ")}.` : "No such surface."}`);
          delete props.action;
        } else props.action = `@${s.id}.${param}`;
      } else if (!/^set:[A-Za-z][\w.-]{0,39}=/.test(a)) {
        errors.push(`${where}: action is "@<surface>.<action>" or "set:<value>=<json>".`);
        delete props.action;
      }
    }
    if (Object.keys(props).length) out.props = props;

    // The bind.
    if (typeof r.bind === "string" && r.bind) {
      if (!spec.value) errors.push(`${where}: a ${atom} shows no value, so it takes no bind.`);
      else {
        const b = bindOk(r.bind, spec.value, ctx, where);
        if (b) out.bind = b;
      }
    } else if (spec.value && spec.control && atom !== "button") {
      errors.push(`${where}: a ${atom} needs a bind: a shared value name ("budget") or a surface parameter ("@image.exposure").`);
    }

    if (spec.control && !off) controls += 1;

    // Children.
    if (spec.container) {
      const kids = Array.isArray(r.children) ? r.children : [];
      if (!kids.length && !ctx.lenient) errors.push(`${where}: a ${atom} holds children; it has none.`);
      const children = kids.map((k, i) => walk(k, depth + 1, off, `${path}.${i + 1}`)).filter((k): k is Node => k !== null);
      out.children = children;
    } else if (Array.isArray(r.children) && r.children.length) errors.push(`${where}: a ${atom} holds no children.`);
    return out;
  };

  const bindOk = (bind: string, kind: ValueKind | null, c: CheckContext, where: string): string | null => {
    const { surface, param } = parseBind(bind.trim());
    if (surface === null) {
      if (!SHARED_NAME.test(param)) { errors.push(`${where}: "${bind}" is not a value name (letters, digits, _ . -, up to 40, starting with a letter).`); return null; }
      return param;
    }
    const sid = resolveSurface(surface, c);
    const s = c.surfaces.find((x) => x.id === sid);
    if (!s) {
      errors.push(`${where}: no ${isKind(surface) ? `${surface} ` : ""}surface "${surface}" on the canvas${c.surfaces.length ? ` (surfaces: ${c.surfaces.map((x) => `${x.id} ${x.kind}`).join(", ")})` : ""}.`);
      return null;
    }
    const p = findParam(s.kind, s.table, param);
    if (!p) {
      const names = paramNames(s.kind, s.table).slice(0, 40);
      errors.push(`${where}: ${s.id} has no parameter "${param}". It has: ${names.join(", ")}.`);
      return null;
    }
    if (kind && !compatible(kind, p.kind)) { errors.push(`${where}: ${s.id}.${param} is ${p.kind}, and this atom holds ${kind}.`); return null; }
    return `@${s.id}.${param}`;
  };

  const tree = walk(raw, 1, false, "root");
  if (tree && controls > MAX_VISIBLE_CONTROLS) {
    errors.push(`${controls} controls in view: a panel shows at most ${MAX_VISIBLE_CONTROLS}. Mark the rarer ones "advanced": true (they wait behind More), or split the panel.`);
  }
  return { tree, errors, controls, nodes };
}

/** The names of every parameter a surface declares, for an error that says what it has. */
function paramNames(kind: SurfaceKind, table: Table | null | undefined): string[] {
  return paramsOf(kind, table).map((p) => p.name);
}

/** Every bind in a tree, buttons' "set:" targets and a bespoke piece's binds included. */
export function bindsOf(tree: Node): string[] {
  const out: string[] = [];
  const walk = (n: Node) => {
    if (n.bind) out.push(n.bind);
    if (n.atom === "bespoke" && Array.isArray(n.props?.binds)) out.push(...(n.props!.binds as string[]));
    if (n.atom === "button" && typeof n.props?.action === "string" && n.props.action.startsWith("set:")) out.push(n.props.action.slice(4, n.props.action.indexOf("=")));
    n.children?.forEach(walk);
  };
  walk(tree);
  return out;
}

/** The kind of value bound at a key in a tree, for checking what the agent or the page sets it to. */
export function kindAt(tree: Node, key: string): ValueKind | null {
  let found: ValueKind | null = null;
  const walk = (n: Node) => {
    if (found) return;
    if (n.bind === key && ATOMS[n.atom].value) found = ATOMS[n.atom].value!;
    n.children?.forEach(walk);
  };
  walk(tree);
  return found;
}

/** Every surface a tree touches: by bind, by a chart's or histogram's surface, by an action. */
export function surfacesOf(tree: Node): string[] {
  const out = new Set<string>();
  for (const b of bindsOf(tree)) { const { surface } = parseBind(b); if (surface) out.add(surface); }
  const walk = (n: Node) => {
    if (typeof n.props?.surface === "string") out.add(n.props.surface);
    if (typeof n.props?.action === "string" && n.props.action.startsWith("@")) { const s = parseBind(n.props.action).surface; if (s) out.add(s); }
    n.children?.forEach(walk);
  };
  walk(tree);
  return [...out];
}

/** The tree with every surface id swapped for its placeholder ("@img3.exposure" -> "@image.exposure"): how a recipe is kept in the library. */
export function generalize(tree: Node, kinds: Record<string, SurfaceKind>): Node {
  const swap = (s: string) => (kinds[s] ? kinds[s] : s);
  const walk = (n: Node): Node => {
    const out: Node = { ...n };
    if (n.bind?.startsWith("@")) { const { surface, param } = parseBind(n.bind); out.bind = `@${swap(surface!)}.${param}`; }
    if (n.props) {
      const props = { ...n.props };
      if (typeof props.surface === "string") props.surface = `@${swap(props.surface)}`;
      if (typeof props.action === "string" && props.action.startsWith("@")) { const { surface, param } = parseBind(props.action); props.action = `@${swap(surface!)}.${param}`; }
      if (Array.isArray(props.binds)) props.binds = (props.binds as string[]).map((b) => { if (!b.startsWith("@")) return b; const { surface, param } = parseBind(b); return `@${swap(surface!)}.${param}`; });
      out.props = props;
    }
    if (n.children) out.children = n.children.map(walk);
    return out;
  };
  return walk(tree);
}

/** The shape of a tree, as a short id: the same panel worded differently, or set to other values, has the same one. */
export function fingerprint(tree: Node): string {
  const WORDS = new Set(["label", "text", "placeholder", "ask", "names", "lanes", "unit"]);
  const canon = (n: Node): unknown => {
    const props = Object.entries(n.props ?? {})
      .filter(([k]) => !WORDS.has(k))
      .map(([k, v]) => [k, k === "html" ? hash(String(v)) : k === "surface" ? "@" : k === "options" && Array.isArray(v) ? (v as Option[]).length : v])
      .sort(([a], [b]) => String(a).localeCompare(String(b)));
    const bind = n.bind ? (n.bind.startsWith("@") ? `@${parseBind(n.bind).param}` : "v") : "";
    return [n.atom, bind, n.advanced ? 1 : 0, props, (n.children ?? []).map(canon)];
  };
  return hash(JSON.stringify(canon(tree)));
}

/** FNV-1a, 32 bits, in base 36. */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}

/** A tree in a line of words, for the agent: "Light: group[slider exposure@img1, slider contrast@img1 …]". */
export function treeWords(n: Node): string {
  const label = typeof n.props?.label === "string" ? ` "${n.props.label}"` : typeof n.props?.text === "string" ? ` "${String(n.props.text).slice(0, 30)}"` : "";
  const bind = n.bind ? ` =${n.bind}` : "";
  const adv = n.advanced ? " (advanced)" : "";
  const kids = n.children?.length ? `[${n.children.map(treeWords).join(", ")}]` : "";
  return `${n.atom}${label}${bind}${adv}${kids}`;
}
