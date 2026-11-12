/**
 * The 3D panels' adapter (docs/PANACEA-GAPS.md, G1): what a `model.*` control shows is read off the model in Autora 3D,
 * and moving it runs the modeller's own tools on the part picked in the panel. Nothing about the model is kept on the
 * canvas: the model is the one source, so the panel, the 3D window and the agent always agree. The one value kept on
 * the canvas is `model.part`, which part a part's controls act on (else the first part).
 *
 * Beyond its shape a part has a surface (its finish's numbers, a pattern) and may grow hair or fur; the scene has a light (its
 * surroundings and brightness), which needs no part. The modeller has no absolute rotation, camera or printer path, so there
 * are no panels for them.
 *
 * Pure: shared by the server (which runs the commands) and the page (which shows the model).
 */
import type { Value } from "../atoms";

export const MODEL_PART = "model.part";

/** A surface's numbers: the bind, the modeller's name for it, and its range. */
const FINISH = {
  "model.roughness": ["roughness", 0, 1],
  "model.metal": ["metalness", 0, 1],
  "model.clear": ["transmission", 0, 1],
  "model.ior": ["ior", 1, 2.5],
  "model.opacity": ["opacity", 0.05, 1],
  "model.sheen": ["sheen", 0, 1],
  "model.through": ["subsurface", 0, 1],
  "model.glow": ["glow", 0, 5],
} as const;
type FinishBind = keyof typeof FINISH;

/** Hair's numbers, the same way. */
const HAIR = {
  "model.hairlength": ["length", 1, 400],
  "model.hairdensity": ["density", 0.2, 80],
  "model.haircurl": ["curl", 0, 1],
  "model.hairfrizz": ["frizz", 0, 1],
  "model.hairlocks": ["clump", 0, 1],
  "model.hairdroop": ["droop", 0, 1],
} as const;
type HairBind = keyof typeof HAIR;

/** The values the adapter acts on. */
const MODEL_BINDS = [
  MODEL_PART, "model.x", "model.y", "model.z", "model.width", "model.depth", "model.height", "model.color", "model.material",
  "model.visible", "model.bevel", "model.bevelstyle", "model.count", "model.gap", "model.dir",
  ...(Object.keys(FINISH) as FinishBind[]), "model.pattern", "model.patterncolor", "model.patternsize", "model.relief",
  "model.hair", "model.hairstyle", ...(Object.keys(HAIR) as HairBind[]), "model.haircolor", "model.hairtip",
  "model.light", "model.brightness",
] as const;

/** Every `model.*` value something acts on: the adapter's, and what the Shapes and Export panels hold for the agent. */
export const MODEL_WIRED: readonly string[] = [...MODEL_BINDS, "model.shape", "model.format"];

export const MATERIALS = ["matte", "metal", "glossy", "glass", "neon", "frosted", "velvet", "skin", "rubber"] as const;

/** Each material's numbers before a part sets its own (the modeller's MATERIAL_PRESETS; tests/panacea-model.test.ts holds them equal). */
export const FINISH_OF: Record<(typeof MATERIALS)[number], { roughness: number; metalness: number; transmission: number; ior: number; opacity: number; sheen: number; subsurface: number; glow: number }> = {
  matte: { roughness: 0.8, metalness: 0.1, transmission: 0, ior: 1.5, opacity: 1, sheen: 0, subsurface: 0, glow: 0 },
  metal: { roughness: 0.2, metalness: 0.95, transmission: 0, ior: 1.5, opacity: 1, sheen: 0, subsurface: 0, glow: 0 },
  glossy: { roughness: 0.05, metalness: 0, transmission: 0, ior: 1.5, opacity: 1, sheen: 0, subsurface: 0, glow: 0 },
  glass: { roughness: 0.1, metalness: 0, transmission: 0.8, ior: 1.5, opacity: 1, sheen: 0, subsurface: 0, glow: 0 },
  neon: { roughness: 0.5, metalness: 0, transmission: 0, ior: 1.5, opacity: 1, sheen: 0, subsurface: 0, glow: 1.5 },
  frosted: { roughness: 0.45, metalness: 0, transmission: 0.9, ior: 1.5, opacity: 1, sheen: 0, subsurface: 0, glow: 0 },
  velvet: { roughness: 0.9, metalness: 0, transmission: 0, ior: 1.5, opacity: 1, sheen: 1, subsurface: 0, glow: 0 },
  skin: { roughness: 0.55, metalness: 0, transmission: 0, ior: 1.5, opacity: 1, sheen: 0.2, subsurface: 0.6, glow: 0 },
  rubber: { roughness: 0.95, metalness: 0, transmission: 0, ior: 1.5, opacity: 1, sheen: 0, subsurface: 0, glow: 0 },
};

/** The patterns the modeller draws (its utils/surface.ts PATTERN_KINDS). */
export const PATTERN_KINDS = ["none", "wood", "marble", "noise", "weave", "scales", "brushed", "checker", "dots"] as const;
export const LIGHTS = ["studio", "daylight", "sunset", "night"] as const;
/** Hair before a part has any (the modeller's DEFAULT_HAIR). */
export const HAIR_START = { style: "strands", length: 40, density: 30, curl: 0, frizz: 0.15, clump: 0.45, droop: 0.6, rootColor: "#2b1a10", tipColor: "#6b4428" } as const;

export function isModelBind(bind: string): boolean {
  return (MODEL_BINDS as readonly string[]).includes(bind);
}

/** The part of a model these panels read: just what they need, so the adapter needs nothing from the modeller. */
interface Pt { x: number; y: number }
export interface ModelBody {
  id: string;
  name: string;
  points: Pt[];
  extrusionHeight: number;
  elevation?: number;
  color: string;
  materialType: string;
  surface?: { [k: string]: unknown; pattern?: { kind: string; color2: string; scale: number; bump: number; angle?: number } };
  hair?: { style: string; length: number; density: number; curl: number; frizz: number; clump: number; droop: number; rootColor: string; tipColor: string };
  visible: boolean;
  edgeBevels?: Array<{ side: string; edge: number; size: number; style: string }>;
  cornerBevels?: Array<{ vertex: number; size: number; style: string }>;
  repeatOf?: string;
}
export interface ModelDoc {
  bodies: ModelBody[];
  look?: { environment: string; exposure: number };
  repeats?: Array<{ bodyId: string; kind: string; count: number; start?: Pt; end?: Pt; bend?: unknown }>;
}

/** What a command is, to be run as the modeller's tool of that name (cad_shape_move and so on, without the prefix). */
interface ModelCommand { tool: string; args: Record<string, unknown> }

const round2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: Value): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** The parts a person can pick: the model's own shapes, not the copies a repeat makes. */
export const modelParts = (doc: ModelDoc): ModelBody[] => doc.bodies.filter((b) => !b.repeatOf);

export function modelOptions(doc: ModelDoc): Array<{ value: string; label: string; color?: string }> {
  return modelParts(doc).map((b) => ({ value: b.id, label: b.name, color: b.color }));
}

/** The part a control acts on: the one picked, else the first. */
function modelPart(doc: ModelDoc, picked: unknown): ModelBody | null {
  const parts = modelParts(doc);
  return parts.find((b) => b.id === picked) ?? parts[0] ?? null;
}

const bounds = (b: ModelBody) => {
  const xs = b.points.map((p) => p.x);
  const ys = b.points.map((p) => p.y);
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
};
const repeatOf = (doc: ModelDoc, b: ModelBody) => doc.repeats?.find((r) => r.bodyId === b.id && r.kind === "path");
const pathGap = (r: NonNullable<ReturnType<typeof repeatOf>>) => (r.start && r.end && r.count > 1 ? Math.hypot(r.end.x - r.start.x, r.end.y - r.start.y) / (r.count - 1) : 0);
const pathDir = (r: NonNullable<ReturnType<typeof repeatOf>>) => {
  if (!r.start || !r.end) return 0;
  const d = (Math.atan2(r.end.y - r.start.y, r.end.x - r.start.x) * 180) / Math.PI;
  return round2((d + 360) % 360);
};

/** What a control shows, read off the model; undefined when the model has nothing for it (no parts yet). */
export function readModel(doc: ModelDoc, bind: string, picked?: unknown): Value | undefined {
  if (bind === MODEL_PART) return modelPart(doc, picked)?.id ?? "";
  // The light is the scene's, so it shows with no parts at all.
  if (bind === "model.light") return doc.look?.environment ?? "studio";
  if (bind === "model.brightness") return doc.look?.exposure ?? 1;
  const b = modelPart(doc, picked);
  if (!b || !b.points.length) return undefined;
  const box = bounds(b);
  switch (bind) {
    case "model.x": return round2((box.x0 + box.x1) / 2);
    case "model.y": return round2((box.y0 + box.y1) / 2);
    case "model.z": return round2(b.elevation ?? 0);
    case "model.width": return round2(box.x1 - box.x0);
    case "model.depth": return round2(box.y1 - box.y0);
    case "model.height": return round2(b.extrusionHeight);
    case "model.color": return b.color;
    case "model.material": return b.materialType;
    case "model.visible": return b.visible;
    case "model.bevel": return round2(Math.max(0, ...(b.edgeBevels ?? []).map((e) => e.size), ...(b.cornerBevels ?? []).map((c) => c.size)));
    case "model.bevelstyle": return b.edgeBevels?.[0]?.style ?? b.cornerBevels?.[0]?.style ?? "round";
    case "model.count": return repeatOf(doc, b)?.count ?? 1;
    case "model.gap": { const r = repeatOf(doc, b); return r ? round2(pathGap(r)) : 50; }
    case "model.dir": { const r = repeatOf(doc, b); return r ? pathDir(r) : 0; }
    case "model.pattern": return b.surface?.pattern?.kind ?? "none";
    case "model.patterncolor": return b.surface?.pattern?.color2 ?? "#3f2a1d";
    case "model.patternsize": return b.surface?.pattern?.scale ?? 60;
    case "model.relief": return b.surface?.pattern?.bump ?? 0.3;
    case "model.hair": return !!b.hair;
    case "model.hairstyle": return b.hair?.style ?? HAIR_START.style;
    case "model.haircolor": return b.hair?.rootColor ?? HAIR_START.rootColor;
    case "model.hairtip": return b.hair?.tipColor ?? HAIR_START.tipColor;
  }
  if (bind in FINISH) {
    const key = FINISH[bind as FinishBind][0];
    const own = b.surface?.[key];
    return typeof own === "number" ? own : FINISH_OF[(MATERIALS as readonly string[]).includes(b.materialType) ? (b.materialType as (typeof MATERIALS)[number]) : "matte"][key];
  }
  if (bind in HAIR) {
    const key = HAIR[bind as HairBind][0];
    return b.hair ? b.hair[key] : HAIR_START[key];
  }
  return undefined;
}

/**
 * The modeller's calls that make a control's value true, on the part it acts on; or why it cannot be. `did` says it in
 * a person's words. `model.part` is not the model's and is not handled here.
 */
export function modelCommands(doc: ModelDoc, bind: string, v: Value, picked?: unknown): { did: string; commands: ModelCommand[] } | { error: string } {
  if (bind === "model.light") {
    if (!(LIGHTS as readonly string[]).includes(String(v))) return { error: `the light is one of ${LIGHTS.join(", ")}` };
    return { did: `light: ${String(v)}`, commands: [{ tool: "scene_look", args: { environment: String(v) } }] };
  }
  if (bind === "model.brightness") {
    const n = num(v);
    if (n === null || n < 0.3 || n > 2) return { error: "the brightness is a number from 0.3 to 2" };
    return { did: `brightness ${n}`, commands: [{ tool: "scene_look", args: { exposure: n } }] };
  }
  const b = modelPart(doc, picked);
  if (!b) return { error: "the model has no parts yet" };
  const id = b.id;
  const one = (tool: string, args: Record<string, unknown>, did: string) => ({ did: `${b.name}: ${did}`, commands: [{ tool, args: { id, ...args } }] });
  switch (bind) {
    case "model.x": case "model.y": case "model.z": {
      const n = num(v);
      if (n === null) return { error: "the position is a number, in mm" };
      const axis = bind.slice(6);
      return { did: `${b.name}: ${axis} ${n} mm`, commands: [{ tool: "shape_move", args: { ids: [id], to: { [axis]: n } } }] };
    }
    case "model.width": case "model.depth": case "model.height": {
      const n = num(v);
      if (n === null || n <= 0) return { error: "the size is a number above zero, in mm" };
      return one("shape_resize", { [bind.slice(6)]: n }, `${bind.slice(6)} ${n} mm`);
    }
    case "model.color":
      if (typeof v !== "string" || !/^#[0-9a-f]{6}$/i.test(v)) return { error: 'the colour is a hex colour such as "#3b82f6"' };
      return one("shape_set", { color: v }, `colour ${v}`);
    case "model.material":
      if (!MATERIALS.includes(String(v) as (typeof MATERIALS)[number])) return { error: `the material is one of ${MATERIALS.join(", ")}` };
      return one("shape_set", { material: String(v) }, `${String(v)}`);
    case "model.visible": return one("shape_set", { visible: v === true }, v === true ? "shown" : "hidden");
    case "model.bevel": {
      const n = num(v);
      if (n === null || n < 0) return { error: "the bevel is a size in mm, 0 or more" };
      return one("edge_bevel", { group: "all", size: n, style: readModel(doc, "model.bevelstyle", id) }, n ? `bevel ${n} mm` : "no bevel");
    }
    case "model.bevelstyle": {
      if (v !== "round" && v !== "chamfer") return { error: "the bevel style is round or chamfer" };
      const size = readModel(doc, "model.bevel", id) as number;
      if (!size) return { error: "give the bevel a size first, then choose its style" };
      return one("edge_bevel", { group: "all", size, style: v }, `${v} bevel`);
    }
    case "model.count": case "model.gap": case "model.dir": {
      const n = num(v);
      if (n === null) return { error: "that is a number" };
      const link = repeatOf(doc, b);
      if (bind === "model.count") {
        const count = Math.round(n);
        if (count < 1) return { error: "the copies are 1 or more" };
        // Letting go of a repeat turns its copies into ordinary shapes: not a thing a stepper should do by surprise.
        if (count === 1) return link ? { error: "the copies are a live repeat; ask Autora to let go of it (the copies would become ordinary shapes)" } : { did: `${b.name}: no copies`, commands: [] };
        return one("repeat_set", { kind: "path", count, gap: readModel(doc, "model.gap", id), direction: readModel(doc, "model.dir", id) }, `${count} copies`);
      }
      if (!link) return { error: "make copies first: set Copies to 2 or more" };
      if (bind === "model.gap" && n <= 0) return { error: "the spacing is above zero, in mm" };
      return one("repeat_set", { kind: "path", count: link.count, gap: bind === "model.gap" ? n : pathGap(link), direction: bind === "model.dir" ? ((n % 360) + 360) % 360 : pathDir(link) }, bind === "model.gap" ? `spacing ${n} mm` : `direction ${n}°`);
    }
    case "model.pattern":
      if (!(PATTERN_KINDS as readonly string[]).includes(String(v))) return { error: `the pattern is one of ${PATTERN_KINDS.join(", ")}` };
      return one("surface_set", { pattern: String(v) }, v === "none" ? "no pattern" : `${String(v)} pattern`);
    case "model.patterncolor": case "model.patternsize": case "model.relief": {
      if (!b.surface?.pattern) return { error: "pick a pattern first" };
      if (bind === "model.patterncolor") {
        if (typeof v !== "string" || !/^#[0-9a-f]{6}$/i.test(v)) return { error: 'the colour is a hex colour such as "#3b82f6"' };
        return one("surface_set", { pattern: { color2: v } }, `pattern colour ${v}`);
      }
      const n = num(v);
      if (bind === "model.patternsize") return n === null || n < 2 || n > 2000 ? { error: "the pattern size is 2 to 2000 mm" } : one("surface_set", { pattern: { scale: n } }, `pattern ${n} mm`);
      return n === null || n < 0 || n > 1 ? { error: "the relief is 0 to 1" } : one("surface_set", { pattern: { bump: n } }, `relief ${Math.round(n * 100)}%`);
    }
    case "model.hair":
      if (typeof v !== "boolean") return { error: "hair is on or off" };
      return v ? (b.hair ? { did: `${b.name}: has hair`, commands: [] } : one("hair_set", { style: HAIR_START.style }, "hair grown")) : b.hair ? one("hair_set", { remove: true }, "hair removed") : { did: `${b.name}: no hair`, commands: [] };
    case "model.hairstyle":
      if (v !== "strands" && v !== "fur") return { error: "the style is strands or fur" };
      return one("hair_set", { style: v }, v === "fur" ? "fur" : "hair");
    case "model.haircolor": case "model.hairtip":
      if (!b.hair) return { error: "grow hair first: turn Hair on" };
      if (typeof v !== "string" || !/^#[0-9a-f]{6}$/i.test(v)) return { error: 'the colour is a hex colour such as "#3b82f6"' };
      return one("hair_set", { [bind === "model.haircolor" ? "rootColor" : "tipColor"]: v }, `${bind === "model.haircolor" ? "root" : "tip"} colour ${v}`);
  }
  if (bind in HAIR && !b.hair) return { error: "grow hair first: turn Hair on" };
  if (bind in FINISH || bind in HAIR) {
    const [key, lo, hi] = bind in FINISH ? FINISH[bind as FinishBind] : HAIR[bind as HairBind];
    const n = num(v);
    if (n === null || n < lo || n > hi) return { error: `the ${key} is a number from ${lo} to ${hi}` };
    return one(bind in FINISH ? "surface_set" : "hair_set", { [key]: n }, `${key} ${n}`);
  }
  return { error: `nothing in the model answers to ${bind}` };
}
