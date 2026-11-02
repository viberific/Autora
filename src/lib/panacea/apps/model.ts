/**
 * The 3D panels' adapter (docs/PANACEA-GAPS.md, G1): what a `model.*` control shows is read off the model in Autora 3D,
 * and moving it runs the modeller's own tools on the part picked in the panel. Nothing about the model is kept on the
 * canvas: the model is the one source, so the panel, the 3D window and the agent always agree. The one value kept on
 * the canvas is `model.part`, which part a part's controls act on (else the first part).
 *
 * The modeller has no absolute rotation, light, camera, environment or printer path, so there are no panels for them.
 *
 * Pure: shared by the server (which runs the commands) and the page (which shows the model).
 */
import type { Value } from "../atoms";

export const MODEL_PART = "model.part";

/** The values the adapter acts on. */
const MODEL_BINDS = [
  MODEL_PART, "model.x", "model.y", "model.z", "model.width", "model.depth", "model.height", "model.color", "model.material",
  "model.visible", "model.bevel", "model.bevelstyle", "model.count", "model.gap", "model.dir",
] as const;

/** Every `model.*` value something acts on: the adapter's, and what the Shapes and Export panels hold for the agent. */
export const MODEL_WIRED: readonly string[] = [...MODEL_BINDS, "model.shape", "model.format"];

export const MATERIALS = ["matte", "metal", "glossy", "glass", "neon"] as const;

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
  visible: boolean;
  edgeBevels?: Array<{ side: string; edge: number; size: number; style: string }>;
  cornerBevels?: Array<{ vertex: number; size: number; style: string }>;
  repeatOf?: string;
}
export interface ModelDoc {
  bodies: ModelBody[];
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
  }
  return undefined;
}

/**
 * The modeller's calls that make a control's value true, on the part it acts on; or why it cannot be. `did` says it in
 * a person's words. `model.part` is not the model's and is not handled here.
 */
export function modelCommands(doc: ModelDoc, bind: string, v: Value, picked?: unknown): { did: string; commands: ModelCommand[] } | { error: string } {
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
  }
  return { error: `nothing in the model answers to ${bind}` };
}
