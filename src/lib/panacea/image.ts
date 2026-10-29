/**
 * The image engine: what a photo on Panacea's canvas is, and everything that can be done to it.
 *
 * A photo is more than its sliders. It has
 *
 *   - **layers** (the photo at the bottom; pixels copied or cut from it, a placed picture, a fill, paint, text, a
 *     healed patch), each with its own visibility, opacity, blend mode, place and a **layer mask** (where it shows);
 *   - **local adjustments** (`masks`): a selection kept with sliders of its own, so the sky gets darker and nothing else;
 *   - a **selection**: the shapes the tools drew (marquee, ellipse, lasso, polygon lasso, brush, magic wand, colour
 *     range, an object the model picked), combined by add, subtract and intersect, with a feather, a grow and an invert;
 *   - **tools**: what a pointer does on the picture, with their options (size, hardness, tolerance, mode, colour);
 *   - **commands**: what can be done, with typed arguments, mostly to the selection (copy it to a layer, fill it, erase
 *     it, remove what is in it, crop to it, adjust it).
 *
 * The person and the agent use the same commands (`runImageCommand`), so the engine's map is one list. Values a panel
 * can bind to are parameters (`imageParams`): the develop sliders, the tool options, and each layer's and each local
 * adjustment's settings (`layer.<id>.opacity`, `mask.<id>.exposure`), so a panel for one layer is atoms like any other.
 *
 * Positions are 0..1 across the photo's own pixels (before crop and rotation); `toSource` turns a point on the picture as
 * shown into one. Shared by the server and the page, so written without DOM or Node types. Pure.
 */
import type { Value } from "./atoms";
import type { ArgSpec, CommandSpec, ParamSpec, ToolSpec } from "./surfaces";

// ------------------------------------------------------------------ model --

/** A shape a tool drew. Points are flat [x0, y0, x1, y1, ...], 0..1 across the photo. */
export type Shape =
  | { type: "all" }
  | { type: "rect"; x: number; y: number; w: number; h: number }
  | { type: "ellipse"; x: number; y: number; w: number; h: number }
  | { type: "polygon"; points: number[] }
  | { type: "stroke"; points: number[]; size: number; hardness?: number }
  | { type: "wand"; x: number; y: number; tolerance: number; contiguous: boolean }
  | { type: "color"; color?: string; x?: number; y?: number; range: number }
  /** An object the segmentation model picked from a click: its mask is kept beside the canvas (server/panacea.ts). */
  | { type: "object"; x: number; y: number; mask?: string };

type SelMode = "add" | "subtract" | "intersect";
export interface SelOp { op: SelMode; shape: Shape }

/** A selection with what is done to it as a whole. Feather and grow are in the photo's own pixels. */
export interface Selection {
  ops: SelOp[];
  feather: number;
  grow: number;
  invert: boolean;
}

/** Where a layer shows: selections added and taken away in order (the eraser takes away). Empty: everywhere. */
export interface MaskEntry { op: "add" | "subtract"; sel: Selection }

export interface Stroke {
  points: number[];
  /** The brush's width, as a share of the picture's long side. */
  size: number;
  color: string;
  /** 0..1. */
  opacity: number;
  hardness: number;
}

export type LayerKind = "photo" | "copy" | "image" | "fill" | "paint" | "text" | "heal";

export interface Layer {
  id: string;
  kind: LayerKind;
  name: string;
  /** A copy's source layer. */
  of?: string;
  /** A placed picture's file. */
  artifact?: string;
  mask?: MaskEntry[];
  /** Paint's brush strokes. */
  strokes?: Stroke[];
}

/** A local adjustment: a selection kept with sliders of its own (`mask.<id>.*`). */
export interface Adjustment {
  id: string;
  name: string;
  sel: Selection;
}

export interface ImageDoc {
  /** Bottom first; the first is the photo. */
  layers: Layer[];
  /** The layer the tools work on. */
  active: string;
  masks: Adjustment[];
  /** The shapes of the current selection; its feather, grow and invert are parameters (`sel.*`). Empty: nothing. */
  selection: SelOp[];
}

const MAX_LAYERS = 24;
/** Local adjustments: one pass on the GPU takes this many. */
export const MAX_MASKS = 6;
const MAX_OPS = 40;
const MAX_POINTS = 4000;
const MAX_STROKES = 300;

export function newImageDoc(): ImageDoc {
  return { layers: [{ id: "photo", kind: "photo", name: "Photo" }], active: "photo", masks: [], selection: [] };
}

// ------------------------------------------------------------------ tools --

export const TOOLS: ToolSpec[] = [
  { name: "pointer", label: "Pointer", about: "click the picture to work on it; nothing is changed", key: "Escape", options: [] },
  { name: "move", label: "Move", about: "drag the active layer (a copy, a placed picture, text, paint) to a new place", key: "v", options: [] },
  { name: "marquee", label: "Rectangle", about: "drag a box to select (Shift adds, Alt takes away)", key: "m", options: ["tool.mode", "sel.feather"] },
  { name: "ellipse", label: "Ellipse", about: "drag an ellipse to select", key: "e", options: ["tool.mode", "sel.feather"] },
  { name: "lasso", label: "Lasso", about: "draw around something freehand to select it", key: "l", options: ["tool.mode", "sel.feather"] },
  { name: "polygon", label: "Polygon lasso", about: "click corner by corner, double-click to close", key: "p", options: ["tool.mode", "sel.feather"] },
  { name: "wand", label: "Magic wand", about: "click a colour to select it and what touches it", key: "w", options: ["tool.mode", "tool.tolerance", "tool.contiguous"] },
  { name: "quick", label: "Brush select", about: "paint over what to select", key: "q", options: ["tool.mode", "tool.size", "tool.hardness"] },
  { name: "object", label: "Object select", about: "click a person, a thing, the sky: the model selects it", key: "o", options: ["tool.mode"] },
  { name: "color", label: "Colour range", about: "click a colour: every pixel like it is selected", key: "r", options: ["tool.mode", "tool.tolerance"] },
  { name: "crop", label: "Crop", about: "drag the frame to crop; the aspect setting keeps its shape", key: "c", options: ["aspect"] },
  { name: "brush", label: "Brush", about: "paint in the foreground colour, on a paint layer", key: "b", options: ["color", "tool.size", "tool.hardness", "tool.opacity"] },
  { name: "eraser", label: "Eraser", about: "rub out the active layer (paint is erased, others are masked)", key: "x", options: ["tool.size", "tool.hardness"] },
  { name: "heal", label: "Heal", about: "paint over a blemish or a speck: it is filled from around it", key: "j", options: ["tool.size"] },
  { name: "text", label: "Text", about: "click where the words go", key: "t", options: ["color"] },
  { name: "eyedropper", label: "Eyedropper", about: "click to take a colour from the picture as the foreground", key: "i", options: ["color"] },
];

const TOOL_NAMES = TOOLS.map((t) => t.name);
const SELECT_TOOLS = new Set(["marquee", "ellipse", "lasso", "polygon", "wand", "quick", "object", "color"]);
export const isSelectTool = (t: string) => SELECT_TOOLS.has(t);

// ------------------------------------------------------------- parameters --

const num = (name: string, label: string, min: number, max: number, extra: Partial<ParamSpec> = {}): ParamSpec =>
  ({ name, kind: "number", label, min, max, step: extra.step ?? 1, default: 0, ...extra });

const HUES = ["red", "orange", "yellow", "green", "aqua", "blue", "purple", "magenta"] as const;
export const HUE_NAMES = HUES;
export const BLENDS = ["normal", "multiply", "screen", "overlay", "soft-light", "hard-light", "darken", "lighten", "color-dodge", "color-burn", "difference", "exclusion", "hue", "saturation", "color", "luminosity"] as const;
const FONTS = ["sans", "serif", "mono", "display", "hand"] as const;

/** The develop settings a local adjustment has, applied only where its selection is. */
export const MASK_PARAMS: ParamSpec[] = [
  num("exposure", "Exposure", -3, 3, { step: 0.05, unit: "EV" }),
  num("contrast", "Contrast", -100, 100),
  num("highlights", "Highlights", -100, 100),
  num("shadows", "Shadows", -100, 100),
  num("temperature", "Temperature", -100, 100),
  num("tint", "Tint", -100, 100),
  num("vibrance", "Vibrance", -100, 100),
  num("saturation", "Saturation", -100, 100),
  num("clarity", "Clarity", -100, 100),
  num("blur", "Blur", 0, 100),
  num("amount", "Amount", 0, 100, { default: 100, unit: "%" }),
];

/** What the whole picture takes beyond the first version's sliders: detail, colour by hue, grading, a free crop. */
const EXTRA_PARAMS: ParamSpec[] = [
  num("sharpen", "Sharpen", 0, 100),
  num("blur", "Blur", 0, 100, { advanced: true }),
  num("dehaze", "Dehaze", -100, 100, { advanced: true }),
  ...HUES.flatMap((h) => [
    num(`hsl.${h}.hue`, `${h[0]!.toUpperCase()}${h.slice(1)} hue`, -100, 100, { advanced: true }),
    num(`hsl.${h}.sat`, `${h[0]!.toUpperCase()}${h.slice(1)} saturation`, -100, 100, { advanced: true }),
    num(`hsl.${h}.lum`, `${h[0]!.toUpperCase()}${h.slice(1)} luminance`, -100, 100, { advanced: true }),
  ]),
  num("grade.shadows_hue", "Shadows hue", 0, 360, { unit: "°", default: 220, advanced: true }),
  num("grade.shadows_sat", "Shadows tint", 0, 100, { advanced: true }),
  num("grade.highlights_hue", "Highlights hue", 0, 360, { unit: "°", default: 40, advanced: true }),
  num("grade.highlights_sat", "Highlights tint", 0, 100, { advanced: true }),
  num("grade.balance", "Grading balance", -100, 100, { advanced: true }),
  { name: "crop", kind: "box", label: "Crop", default: [0, 0, 1, 1] },
];

/** The tools and their options, and the current selection's feather, grow and invert. */
const TOOL_PARAMS: ParamSpec[] = [
  { name: "tool", kind: "choice", label: "Tool", options: TOOL_NAMES, default: "pointer" },
  { name: "tool.mode", kind: "choice", label: "Selection mode", options: ["new", "add", "subtract", "intersect"], default: "new" },
  num("tool.size", "Brush size", 0.2, 40, { step: 0.1, default: 4, unit: "%" }),
  num("tool.hardness", "Hardness", 0, 100, { default: 70, unit: "%" }),
  num("tool.opacity", "Opacity", 1, 100, { default: 100, unit: "%" }),
  num("tool.tolerance", "Tolerance", 0, 100, { default: 24 }),
  { name: "tool.contiguous", kind: "bool", label: "Contiguous", default: true },
  { name: "color", kind: "color", label: "Colour", default: "#ffffff" },
  num("sel.feather", "Feather", 0, 250, { unit: "px" }),
  num("sel.grow", "Grow / shrink", -100, 100, { unit: "px" }),
  { name: "sel.invert", kind: "bool", label: "Invert selection", default: false },
];

/** A layer's own settings, by kind. */
function layerParams(l: Layer): ParamSpec[] {
  const p = (name: string, rest: Omit<ParamSpec, "name">): ParamSpec => ({ name: `layer.${l.id}.${name}`, ...rest });
  const out: ParamSpec[] = [
    p("visible", { kind: "bool", label: `${l.name}: shown`, default: true }),
    p("opacity", { kind: "number", label: `${l.name}: opacity`, min: 0, max: 100, step: 1, unit: "%", default: 100 }),
    p("blend", { kind: "choice", label: `${l.name}: blend`, options: [...BLENDS], default: "normal" }),
  ];
  if (l.kind === "copy" || l.kind === "paint") {
    out.push(p("dx", { kind: "number", label: `${l.name}: across`, min: -1, max: 1, step: 0.001, default: 0 }));
    out.push(p("dy", { kind: "number", label: `${l.name}: down`, min: -1, max: 1, step: 0.001, default: 0 }));
  }
  if (l.kind === "image" || l.kind === "text") {
    out.push(p("x", { kind: "number", label: `${l.name}: across`, min: -0.5, max: 1.5, step: 0.001, default: 0.5 }));
    out.push(p("y", { kind: "number", label: `${l.name}: down`, min: -0.5, max: 1.5, step: 0.001, default: 0.5 }));
  }
  if (l.kind === "copy" || l.kind === "image" || l.kind === "text") {
    out.push(p("scale", { kind: "number", label: `${l.name}: size`, min: 0.05, max: 8, step: 0.01, default: 1 }));
    out.push(p("angle", { kind: "number", label: `${l.name}: angle`, min: -180, max: 180, step: 0.5, unit: "°", default: 0 }));
  }
  if (l.kind === "fill" || l.kind === "text") out.push(p("color", { kind: "color", label: `${l.name}: colour`, default: l.kind === "text" ? "#ffffff" : "#000000" }));
  if (l.kind === "text") {
    out.push(p("text", { kind: "text", label: `${l.name}: words`, default: "Text" }));
    out.push(p("size", { kind: "number", label: `${l.name}: type size`, min: 1, max: 60, step: 0.5, unit: "%", default: 8 }));
    out.push(p("font", { kind: "choice", label: `${l.name}: font`, options: [...FONTS], default: "sans" }));
    out.push(p("bold", { kind: "bool", label: `${l.name}: bold`, default: true }));
    out.push(p("align", { kind: "choice", label: `${l.name}: align`, options: ["left", "center", "right"], default: "center" }));
    out.push(p("shadow", { kind: "bool", label: `${l.name}: shadow`, default: false }));
  }
  return out;
}

/** Everything a photo lets a control bind to, past the first version's develop sliders: those come first (surfaces.ts). */
export function imageParams(doc: ImageDoc | null | undefined): ParamSpec[] {
  const d = doc ?? newImageDoc();
  return [
    ...EXTRA_PARAMS,
    ...TOOL_PARAMS,
    ...d.layers.filter((l) => l.kind !== "photo").flatMap(layerParams),
    ...(d.layers[0] ? layerParams(d.layers[0]).filter((p) => /\.(visible|opacity|blend)$/.test(p.name)) : []),
    ...d.masks.flatMap((m) => MASK_PARAMS.map((p) => ({ ...p, name: `mask.${m.id}.${p.name}`, label: `${m.name}: ${p.label.toLowerCase()}` }))),
  ];
}

// --------------------------------------------------------------- commands --

const arg = (name: string, kind: ArgSpec["kind"], label: string, extra: Partial<ParamSpec> = {}): ArgSpec => ({ name, kind, label, default: null, ...extra });
const XY = [arg("x", "number", "Across, 0..1", { min: 0, max: 1, required: true }), arg("y", "number", "Down, 0..1", { min: 0, max: 1, required: true })];
const BOX = [...XY, arg("w", "number", "Width, 0..1", { min: 0, max: 1, required: true }), arg("h", "number", "Height, 0..1", { min: 0, max: 1, required: true })];
const MODE = arg("mode", "choice", "new, add, subtract or intersect (default: the tool's mode)", { options: ["new", "add", "subtract", "intersect"] });
const POINTS = arg("points", "points2", "[[x, y], ...] around it, 0..1", { required: true });

/** Every command, in the order the All tools grid and the agent's index list them. */
export const IMAGE_COMMANDS: CommandSpec[] = [
  // Selecting.
  { name: "select.rect", group: "Select", label: "Select a box", about: "a rectangle", args: [...BOX, MODE] },
  { name: "select.ellipse", group: "Select", label: "Select an ellipse", about: "an ellipse in the box", args: [...BOX, MODE] },
  { name: "select.polygon", group: "Select", label: "Select around", about: "a lasso or polygon through the points", args: [POINTS, MODE] },
  { name: "select.brush", group: "Select", label: "Brush a selection", about: "a brushed line of a size", args: [POINTS, arg("size", "number", "Brush width, % of the long side", { min: 0.2, max: 40 }), MODE] },
  { name: "select.wand", group: "Select", label: "Magic wand", about: "the colour at a point and what touches it", args: [...XY, arg("tolerance", "number", "0..100", { min: 0, max: 100 }), arg("contiguous", "bool", "Only what touches it (default yes)"), MODE] },
  { name: "select.color", group: "Select", label: "Colour range", about: "every pixel near a colour, given or taken at a point", args: [arg("color", "color", "#rrggbb"), arg("x", "number", "Or across, 0..1", { min: 0, max: 1 }), arg("y", "number", "and down", { min: 0, max: 1 }), arg("range", "number", "0..100", { min: 0, max: 100 }), MODE] },
  { name: "select.object", group: "Select", label: "Select an object", about: "the thing at a point, found by the segmentation model", args: [...XY, MODE], needs: "window" },
  { name: "select.subject", group: "Select", label: "Select subject", about: "the main subject, found by the segmentation model", args: [MODE], needs: "window" },
  { name: "select.all", group: "Select", label: "Select all", about: "the whole picture", args: [], key: "mod+a" },
  { name: "select.none", group: "Select", label: "Deselect", about: "nothing selected", args: [], key: "mod+d" },
  { name: "select.invert", group: "Select", label: "Invert", about: "everything but the selection", args: [], key: "mod+shift+i", needs: "selection" },
  { name: "select.feather", group: "Select", label: "Feather", about: "a soft edge, in pixels", args: [arg("px", "number", "Pixels", { min: 0, max: 250, required: true })], needs: "selection" },
  { name: "select.grow", group: "Select", label: "Grow or shrink", about: "the edge moved out (or in, negative), in pixels", args: [arg("px", "number", "Pixels", { min: -100, max: 100, required: true })], needs: "selection" },
  // Layers.
  { name: "layer.copy", group: "Layers", label: "Copy to layer", about: "the selection (or the whole layer) as a new layer above, to move or change on its own", args: [], key: "mod+j" },
  { name: "layer.cut", group: "Layers", label: "Cut to layer", about: "the selection lifted out onto a new layer", args: [], key: "mod+shift+j", needs: "selection" },
  { name: "layer.fill", group: "Layers", label: "Fill", about: "the selection (or everything) with a colour, as a layer", args: [arg("color", "color", "#rrggbb (default: the foreground colour)")], key: "shift+backspace" },
  { name: "layer.erase", group: "Layers", label: "Delete selection", about: "the selection taken out of the active layer (its mask)", args: [], key: "delete", needs: "selection" },
  { name: "layer.remove", group: "Layers", label: "Remove", about: "what is selected filled in from around it (blemishes, specks, wires, small things)", args: [], needs: "selection" },
  { name: "layer.text", group: "Layers", label: "Add text", about: "words on a layer of their own", args: [arg("text", "text", "The words", { required: true }), arg("x", "number", "Centre across, 0..1"), arg("y", "number", "Centre down, 0..1"), arg("size", "number", "Type size, % of the height", { min: 1, max: 60 }), arg("color", "color", "#rrggbb"), arg("font", "choice", "sans, serif, mono, display, hand", { options: [...FONTS] })] },
  { name: "layer.place", group: "Layers", label: "Place a picture", about: "another picture on a layer of its own (logo, sticker, second photo)", args: [arg("artifact", "text", "The picture's artifact id", { required: true }), arg("x", "number", "Centre across"), arg("y", "number", "Centre down"), arg("scale", "number", "Size, 1 = as wide as fits", { min: 0.05, max: 8 })] },
  { name: "layer.paint", group: "Layers", label: "Paint", about: "a brush stroke through the points, on a paint layer", args: [POINTS, arg("size", "number", "Brush width, % of the long side", { min: 0.2, max: 40 }), arg("color", "color", "#rrggbb"), arg("opacity", "number", "0..100", { min: 1, max: 100 })] },
  { name: "layer.erase_stroke", group: "Layers", label: "Erase a stroke", about: "the eraser through the points, on the active layer", args: [POINTS, arg("size", "number", "Width, % of the long side", { min: 0.2, max: 40 })] },
  { name: "layer.heal_stroke", group: "Layers", label: "Heal a stroke", about: "the heal brush through the points", args: [POINTS, arg("size", "number", "Width, % of the long side", { min: 0.2, max: 40 })] },
  { name: "layer.new", group: "Layers", label: "New layer", about: "an empty paint layer", args: [arg("name", "text", "Its name")] },
  { name: "layer.select", group: "Layers", label: "Pick a layer", about: "the layer the tools work on", args: [arg("id", "text", "The layer's id", { required: true })] },
  { name: "layer.rename", group: "Layers", label: "Rename layer", about: "a layer's name", args: [arg("id", "text", "The layer (default the active one)"), arg("name", "text", "The new name", { required: true })] },
  { name: "layer.up", group: "Layers", label: "Bring forward", about: "a layer one place up", args: [arg("id", "text", "The layer (default the active one)")], key: "mod+]" },
  { name: "layer.down", group: "Layers", label: "Send backward", about: "a layer one place down", args: [arg("id", "text", "The layer (default the active one)")], key: "mod+[" },
  { name: "layer.delete", group: "Layers", label: "Delete layer", about: "a layer gone (the photo stays)", args: [arg("id", "text", "The layer (default the active one)")] },
  { name: "layer.mask_clear", group: "Layers", label: "Clear layer mask", about: "a layer shown everywhere again", args: [arg("id", "text", "The layer (default the active one)")] },
  // Local adjustments.
  { name: "mask.add", group: "Adjust", label: "Adjust selection", about: "the selection kept with sliders of its own (exposure, colour, clarity, blur only there)", args: [arg("name", "text", "What it is (Sky, Face)"), ...MASK_PARAMS.map((p) => ({ ...p, default: null }))], needs: "selection" },
  { name: "mask.delete", group: "Adjust", label: "Delete adjustment", about: "a local adjustment gone", args: [arg("id", "text", "The adjustment's id", { required: true })] },
  // The picture.
  { name: "image.crop", group: "Image", label: "Crop to a box", about: "the frame, as 0..1 of the picture as shown before cropping", args: BOX },
  { name: "image.crop_selection", group: "Image", label: "Crop to selection", about: "the frame around what is selected", args: [], needs: "selection" },
  { name: "image.uncrop", group: "Image", label: "Clear crop", about: "the whole frame back", args: [] },
  { name: "reset", group: "Image", label: "Reset", about: "every adjustment back to the original (layers stay)", args: [] },
  { name: "auto", group: "Image", label: "Auto", about: "exposure, contrast and white balance worked out from the picture", args: [], needs: "window" },
  { name: "export", group: "Image", label: "Export", about: "the edited picture saved to the project as a PNG", args: [], needs: "window" },
];

// ------------------------------------------------------------- geometry --

type Mat3 = [number, number, number, number, number, number, number, number, number];
const mul = (a: Mat3, b: Mat3): Mat3 => {
  const o = new Array(9).fill(0) as Mat3;
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) o[r * 3 + c] += a[r * 3 + k]! * b[k * 3 + c]!;
  return o;
};
const T = (x: number, y: number): Mat3 => [1, 0, x, 0, 1, y, 0, 0, 1];
const S = (x: number, y: number): Mat3 => [x, 0, 0, 0, y, 0, 0, 0, 1];
const R = (a: number): Mat3 => [Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a), 0, 0, 0, 1];
const n0 = (v: Value | undefined, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);

/** The free crop, [x, y, w, h] of the frame before it. */
export function cropOf(params: Record<string, Value>): [number, number, number, number] {
  const c = params.crop;
  if (Array.isArray(c) && c.length === 4 && c.every((v) => typeof v === "number")) return c as [number, number, number, number];
  return [0, 0, 1, 1];
}

/** The output's aspect, width over height, before (`uncropped`) or after the free crop. */
export function outputAspect(params: Record<string, Value>, w: number, h: number, uncropped = false): number {
  const quarter = Number(params.rotate ?? "0") % 180 !== 0;
  const src = quarter ? h / w : w / h;
  const a = String(params.aspect ?? "original");
  const m = /^(\d+):(\d+)$/.exec(a);
  const base = m ? Number(m[1]) / Number(m[2]) : src;
  if (uncropped) return base;
  const [, , cw, ch] = cropOf(params);
  return base * (cw / Math.max(1e-6, ch));
}

/** The matrix (row-major) from output uv to the photo's uv. `uncropped` leaves the free crop out (the crop tool shows the whole frame). */
export function geometry(params: Record<string, Value>, w: number, h: number, uncropped = false): Mat3 {
  const quarter = (Number(params.rotate ?? "0") / 90) % 4;
  const ar = quarter % 2 ? h / w : w / h;
  const aout = outputAspect(params, w, h, true);
  const th = (n0(params.straighten) * Math.PI) / 180;
  const zoom = Math.max(1, n0(params.zoom, 1));
  const cs = Math.abs(Math.cos(th));
  const sn = Math.abs(Math.sin(th));
  const hh = Math.min(ar / (cs * aout + sn), 1 / (sn * aout + cs)) / zoom;
  const fx = params.flip_h === true ? -1 : 1;
  const fy = params.flip_v === true ? -1 : 1;
  const [cx, cy, cw, ch] = uncropped ? [0, 0, 1, 1] : cropOf(params);
  // Output uv -> the free crop -> flipped -> the box in the rotated frame's units -> rotated-frame uv -> the photo's uv.
  let m: Mat3 = mul(T(cx, cy), S(cw, ch));
  m = mul(mul(T(0.5, 0.5), mul(S(fx, fy), T(-0.5, -0.5))), m);
  m = mul(mul(T(0.5, 0.5), mul(S(1 / ar, 1), mul(R(th), S(aout * hh, hh)))), mul(T(-0.5, -0.5), m));
  m = mul(mul(T(0.5, 0.5), mul(R((-quarter * Math.PI) / 2), T(-0.5, -0.5))), m);
  return m;
}

export function invert3(m: Mat3): Mat3 {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h; const B = -(d * i - f * g); const C = d * h - e * g;
  const det = a * A + b * B + c * C || 1e-12;
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}

const apply3 = (m: Mat3, x: number, y: number): [number, number] => [m[0] * x + m[1] * y + m[2], m[3] * x + m[4] * y + m[5]];

/** A point on the picture as shown (0..1 from its top left) as a point on the photo itself. */
export function toSource(params: Record<string, Value>, px: { w: number; h: number }, x: number, y: number, uncropped = false): [number, number] {
  return apply3(geometry(params, px.w, px.h, uncropped), x, y);
}

/** A point on the photo as a point on the picture as shown. */
export function toOutput(params: Record<string, Value>, px: { w: number; h: number }, x: number, y: number, uncropped = false): [number, number] {
  return apply3(invert3(geometry(params, px.w, px.h, uncropped)), x, y);
}

// ------------------------------------------------------------- selections --

/** The current selection, whole: its shapes and the feather, grow and invert set on the surface. */
export function selectionOf(doc: ImageDoc, params: Record<string, Value>): Selection | null {
  if (!doc.selection.length) return null;
  return { ops: doc.selection, feather: n0(params["sel.feather"]), grow: n0(params["sel.grow"]), invert: params["sel.invert"] === true };
}

const r4 = (v: number) => Math.round(v * 10000) / 10000;
const flat = (pts: unknown): number[] | null => {
  if (!Array.isArray(pts)) return null;
  const out: number[] = [];
  for (const p of pts) {
    if (Array.isArray(p) && p.length === 2 && typeof p[0] === "number" && typeof p[1] === "number") out.push(r4(p[0]), r4(p[1]));
    else if (typeof p === "number") out.push(r4(p));
  }
  return out.length >= 2 && out.length % 2 === 0 ? out.slice(0, MAX_POINTS * 2) : null;
};

/** Points kept as few as draw the same line: a freehand drag sends hundreds. */
export function thinPoints(pts: number[], min = 0.002): number[] {
  if (pts.length <= 4) return pts;
  const out = [pts[0]!, pts[1]!];
  for (let i = 2; i < pts.length - 2; i += 2) {
    if (Math.hypot(pts[i]! - out[out.length - 2]!, pts[i + 1]! - out[out.length - 1]!) >= min) out.push(pts[i]!, pts[i + 1]!);
  }
  out.push(pts[pts.length - 2]!, pts[pts.length - 1]!);
  return out.slice(0, MAX_POINTS * 2);
}

/** A shape added to the selection the way `mode` says: new replaces it. */
function addShape(doc: ImageDoc, shape: Shape, mode: string) {
  const op: SelMode = mode === "subtract" || mode === "intersect" || mode === "add" ? mode : "add";
  if (mode === "new" || !doc.selection.length) doc.selection = op === "subtract" ? [] : [{ op: "add", shape }];
  else doc.selection = [...doc.selection, { op, shape }].slice(-MAX_OPS);
}

/** The box around a selection worked out from its shapes alone, when they say it (no wand, colour or object); else null. */
export function shapeBounds(sel: Selection): { x: number; y: number; w: number; h: number } | null {
  if (sel.invert) return { x: 0, y: 0, w: 1, h: 1 };
  let box: [number, number, number, number] | null = null;
  for (const { op, shape } of sel.ops) {
    let b: [number, number, number, number];
    if (shape.type === "all") b = [0, 0, 1, 1];
    else if (shape.type === "rect" || shape.type === "ellipse") b = [shape.x, shape.y, shape.x + shape.w, shape.y + shape.h];
    else if (shape.type === "polygon" || shape.type === "stroke") {
      const xs = shape.points.filter((_, i) => i % 2 === 0);
      const ys = shape.points.filter((_, i) => i % 2 === 1);
      const pad = shape.type === "stroke" ? shape.size / 2 : 0;
      b = [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad];
    } else return null;
    if (op === "subtract") continue;
    if (!box) box = b;
    else if (op === "add") box = [Math.min(box[0], b[0]), Math.min(box[1], b[1]), Math.max(box[2], b[2]), Math.max(box[3], b[3])];
    else box = [Math.max(box[0], b[0]), Math.max(box[1], b[1]), Math.min(box[2], b[2]), Math.min(box[3], b[3])];
  }
  if (!box) return null;
  const g = sel.grow / 2000 + sel.feather / 4000;
  const x0 = Math.max(0, box[0] - g); const y0 = Math.max(0, box[1] - g);
  const x1 = Math.min(1, box[2] + g); const y1 = Math.min(1, box[3] + g);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

/** A selection in words, for the agent. */
function selectionWords(sel: Selection | null): string {
  if (!sel) return "nothing selected";
  const shape = (s: Shape): string => {
    switch (s.type) {
      case "all": return "all";
      case "rect": case "ellipse": return `${s.type} ${[s.x, s.y, s.w, s.h].map((v) => v.toFixed(3)).join(",")}`;
      case "polygon": return `lasso of ${s.points.length / 2} points`;
      case "stroke": return `brush stroke of ${s.points.length / 2} points`;
      case "wand": return `wand at ${s.x.toFixed(3)},${s.y.toFixed(3)} tolerance ${s.tolerance}${s.contiguous ? "" : " anywhere"}`;
      case "color": return `colour range ${s.color ?? `at ${s.x?.toFixed(3)},${s.y?.toFixed(3)}`} ±${s.range}`;
      case "object": return `object at ${s.x.toFixed(3)},${s.y.toFixed(3)}${s.mask ? "" : " (not found yet)"}`;
    }
  };
  const ops = sel.ops.map((o, i) => `${i ? `${o.op} ` : ""}${shape(o.shape)}`).join("; ");
  return `${ops}${sel.feather ? `; feather ${sel.feather}px` : ""}${sel.grow ? `; ${sel.grow > 0 ? "grown" : "shrunk"} ${Math.abs(sel.grow)}px` : ""}${sel.invert ? "; inverted" : ""}`;
}

// ------------------------------------------------------------------ running --

let made = 0;
const newId = (prefix: string, taken: Set<string>) => {
  let id: string;
  do { made = (made + 1) % 46656; id = `${prefix}${Date.now().toString(36).slice(-3)}${made.toString(36)}`; } while (taken.has(id));
  return id;
};

/** What `runImageCommand` works on: a surface's own model and values. */
export interface ImageTarget {
  image: ImageDoc;
  params: Record<string, Value>;
  px?: { w: number; h: number };
}

/** What the page can do and the server cannot, handed in where there is a picture: where a selection really is. */
export interface PixelEnv {
  /** The box around the current selection, worked out from its pixels. */
  bounds?: (sel: Selection) => { x: number; y: number; w: number; h: number } | null;
}

export type CommandResult = { ok: true; said: string; layer?: string; mask?: string } | { ok: false; error: string; window?: boolean };

const fail = (error: string, window = false): CommandResult => ({ ok: false, error, ...(window ? { window } : {}) });
const numArg = (v: unknown, d: number, lo = -Infinity, hi = Infinity) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const colorArg = (v: unknown, d: string) => (typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : d);

/** Snapshot of the current selection, to keep in a layer mask or a local adjustment: later edits to it do not change them. */
const frozen = (sel: Selection): Selection => structuredClone(sel);

/** The layer an id names, or the active one. */
function layerFor(doc: ImageDoc, id: unknown): Layer | null {
  return doc.layers.find((l) => l.id === (typeof id === "string" && id ? id : doc.active)) ?? null;
}

function insertAbove(t: ImageTarget, layer: Layer): string | null {
  const doc = t.image;
  if (doc.layers.length >= MAX_LAYERS) return `A picture has at most ${MAX_LAYERS} layers; delete one first.`;
  const i = doc.layers.findIndex((l) => l.id === doc.active);
  doc.layers.splice(i < 0 ? doc.layers.length : i + 1, 0, layer);
  doc.active = layer.id;
  return null;
}

const taken = (doc: ImageDoc) => new Set([...doc.layers.map((l) => l.id), ...doc.masks.map((m) => m.id)]);

/** Drop a layer's or an adjustment's values when it goes. */
function dropParams(params: Record<string, Value>, prefix: string) {
  for (const k of Object.keys(params)) if (k.startsWith(prefix)) delete params[k];
}

/** A paint layer to paint on: the active one if it is one, else a new one above it. */
function paintLayer(t: ImageTarget): Layer | string {
  const l = layerFor(t.image, null);
  if (l?.kind === "paint") return l;
  const layer: Layer = { id: newId("l", taken(t.image)), kind: "paint", name: "Paint", strokes: [] };
  return insertAbove(t, layer) ?? layer;
}

/**
 * Run one command on a photo. The same for the person (a button, a key, a tool) and the agent (panacea_do), so the
 * engine has one map. Changes `t` in place. What only the window can do (find an object, read the picture) says so
 * with `window: true`; where the page has the picture it hands in `env`.
 */
export function runImageCommand(t: ImageTarget, name: string, args: Record<string, unknown> = {}, env: PixelEnv = {}): CommandResult {
  const doc = t.image;
  const p = t.params;
  const sel = selectionOf(doc, p);
  const spec = IMAGE_COMMANDS.find((c) => c.name === name);
  if (!spec) return fail(`There is no image command "${name}". Commands: ${IMAGE_COMMANDS.map((c) => c.name).join(", ")}.`);
  for (const a of spec.args) if (a.required && (args[a.name] === undefined || args[a.name] === null || args[a.name] === "")) return fail(`${name} needs ${a.name} (${a.label}).`);
  if (spec.needs === "selection" && !sel) return fail(`${spec.label} works on a selection, and nothing is selected. Select something first (a select.* command, or a selection tool).`);
  const mode = typeof args.mode === "string" ? args.mode : String(p["tool.mode"] ?? "new");
  const pick = (shape: Shape, what: string): CommandResult => {
    addShape(doc, shape, mode);
    if (mode === "new") p["sel.invert"] = false;
    return { ok: true, said: `${mode === "new" ? "Selected" : `${mode[0]!.toUpperCase()}${mode.slice(1)}ed`} ${what}.` };
  };
  switch (name) {
    case "select.rect": case "select.ellipse": {
      const x = numArg(args.x, 0, 0, 1); const y = numArg(args.y, 0, 0, 1);
      const w = numArg(args.w, 0, 0, 1 - x); const h = numArg(args.h, 0, 0, 1 - y);
      if (w <= 0 || h <= 0) return fail("The box has no size.");
      return pick({ type: name === "select.rect" ? "rect" : "ellipse", x: r4(x), y: r4(y), w: r4(w), h: r4(h) }, `a ${name === "select.rect" ? "box" : "ellipse"}`);
    }
    case "select.polygon": {
      const pts = flat(args.points);
      if (!pts || pts.length < 6) return fail("A lasso needs at least three points: [[x, y], ...].");
      return pick({ type: "polygon", points: thinPoints(pts, 0.001) }, `around ${pts.length / 2} points`);
    }
    case "select.brush": {
      const pts = flat(args.points);
      if (!pts) return fail("A brushed selection needs points: [[x, y], ...].");
      return pick({ type: "stroke", points: thinPoints(pts), size: numArg(args.size, numArg(p["tool.size"], 4)) / 100, hardness: numArg(p["tool.hardness"], 70) / 100 }, "a brushed area");
    }
    case "select.wand":
      return pick({ type: "wand", x: r4(numArg(args.x, 0.5, 0, 1)), y: r4(numArg(args.y, 0.5, 0, 1)), tolerance: numArg(args.tolerance, numArg(p["tool.tolerance"], 24), 0, 100), contiguous: typeof args.contiguous === "boolean" ? args.contiguous : p["tool.contiguous"] !== false }, "the colour there");
    case "select.color": {
      const color = typeof args.color === "string" && /^#[0-9a-f]{6}$/i.test(args.color) ? args.color.toLowerCase() : undefined;
      if (!color && (typeof args.x !== "number" || typeof args.y !== "number")) return fail("Give `color` (#rrggbb) or a point (`x`, `y`) to take it from.");
      return pick({ type: "color", ...(color ? { color } : { x: r4(args.x as number), y: r4(args.y as number) }), range: numArg(args.range, numArg(p["tool.tolerance"], 24), 0, 100) }, color ? `everything near ${color}` : "everything that colour");
    }
    case "select.object": case "select.subject": {
      if (typeof args.mask !== "string") return fail("Finding an object needs the Panacea window open: its model runs there.", true);
      return pick({ type: "object", x: r4(numArg(args.x, 0.5, 0, 1)), y: r4(numArg(args.y, 0.5, 0, 1)), mask: args.mask.slice(0, 80) }, name === "select.subject" ? "the subject" : "the object there");
    }
    case "select.all": doc.selection = [{ op: "add", shape: { type: "all" } }]; p["sel.invert"] = false; return { ok: true, said: "Selected all." };
    case "select.none": doc.selection = []; p["sel.invert"] = false; p["sel.feather"] = 0; p["sel.grow"] = 0; return { ok: true, said: "Deselected." };
    case "select.invert": p["sel.invert"] = !(p["sel.invert"] === true); return { ok: true, said: "Inverted the selection." };
    case "select.feather": p["sel.feather"] = numArg(args.px, 0, 0, 250); return { ok: true, said: `Feathered ${p["sel.feather"]}px.` };
    case "select.grow": p["sel.grow"] = numArg(args.px, 0, -100, 100); return { ok: true, said: `${(p["sel.grow"] as number) >= 0 ? "Grew" : "Shrank"} it ${Math.abs(p["sel.grow"] as number)}px.` };

    case "layer.copy": case "layer.cut": {
      const from = layerFor(doc, null);
      if (!from) return fail("There is no active layer.");
      if (from.kind === "text" || from.kind === "fill") return fail(`${from.name} is a ${from.kind} layer; copy works on pixels (the photo, a copy, a picture, paint).`);
      const id = newId("l", taken(doc));
      const source = from.kind === "copy" ? from.of ?? "photo" : from.id;
      const layer: Layer = { id, kind: from.kind === "image" ? "image" : from.kind === "paint" ? "paint" : "copy", name: name === "layer.cut" ? "Cut out" : sel ? "Copy" : `${from.name} copy`, ...(from.kind === "image" ? { artifact: from.artifact } : {}), ...(from.kind === "paint" ? { strokes: structuredClone(from.strokes ?? []) } : {}), ...(from.kind !== "image" && from.kind !== "paint" ? { of: source } : {}), mask: [...(sel ? [{ op: "add" as const, sel: frozen(sel) }] : structuredClone(from.mask ?? []))] };
      // Its place and size follow the layer it came from.
      for (const k of ["dx", "dy", "x", "y", "scale", "angle"]) if (p[`layer.${from.id}.${k}`] !== undefined) p[`layer.${id}.${k}`] = p[`layer.${from.id}.${k}`]!;
      const bad = insertAbove(t, layer);
      if (bad) return fail(bad);
      if (name === "layer.cut" && sel) from.mask = [...(from.mask ?? []), { op: "subtract", sel: frozen(sel) }];
      doc.selection = [];
      return { ok: true, said: `${name === "layer.cut" ? "Cut" : "Copied"} ${sel ? "the selection" : from.name} to layer ${id} "${layer.name}" (active; the Move tool drags it).`, layer: id };
    }
    case "layer.fill": {
      const id = newId("l", taken(doc));
      const layer: Layer = { id, kind: "fill", name: "Fill", mask: sel ? [{ op: "add", sel: frozen(sel) }] : [] };
      const bad = insertAbove(t, layer);
      if (bad) return fail(bad);
      p[`layer.${id}.color`] = colorArg(args.color, colorArg(p.color, "#000000"));
      return { ok: true, said: `Filled ${sel ? "the selection" : "the picture"} with ${p[`layer.${id}.color`] as string} on layer ${id}.`, layer: id };
    }
    case "layer.erase": {
      const l = layerFor(doc, null)!;
      l.mask = [...(l.mask ?? []), { op: "subtract", sel: frozen(sel!) }];
      return { ok: true, said: `Took the selection out of ${l.name} (its mask: Clear layer mask brings it back).` };
    }
    case "layer.remove": {
      const top = doc.layers.at(-1);
      // Successive removals go on one heal layer while it is the top one.
      if (top?.kind === "heal") { top.mask = [...(top.mask ?? []), { op: "add", sel: frozen(sel!) }]; doc.active = top.id; doc.selection = []; return { ok: true, said: `Removed what was selected (on ${top.name}).`, layer: top.id }; }
      const id = newId("l", taken(doc));
      const layer: Layer = { id, kind: "heal", name: "Removed", mask: [{ op: "add", sel: frozen(sel!) }] };
      if (doc.layers.length >= MAX_LAYERS) return fail(`A picture has at most ${MAX_LAYERS} layers.`);
      doc.layers.push(layer);
      doc.active = id;
      doc.selection = [];
      return { ok: true, said: `Removed what was selected: filled in from around it, on layer ${id} "Removed" (hide or delete it to bring it back).`, layer: id };
    }
    case "layer.heal_stroke": {
      const pts = flat(args.points);
      if (!pts) return fail("Give the points the heal brush goes through.");
      const s: Selection = { ops: [{ op: "add", shape: { type: "stroke", points: thinPoints(pts), size: numArg(args.size, numArg(p["tool.size"], 4), 0.2, 40) / 100, hardness: 0.8 } }], feather: 0, grow: 0, invert: false };
      const top = doc.layers.at(-1);
      if (top?.kind === "heal") { top.mask = [...(top.mask ?? []), { op: "add", sel: s }]; doc.active = top.id; return { ok: true, said: "Healed along the stroke.", layer: top.id }; }
      const id = newId("l", taken(doc));
      if (doc.layers.length >= MAX_LAYERS) return fail(`A picture has at most ${MAX_LAYERS} layers.`);
      doc.layers.push({ id, kind: "heal", name: "Healed", mask: [{ op: "add", sel: s }] });
      doc.active = id;
      return { ok: true, said: `Healed along the stroke, on layer ${id}.`, layer: id };
    }
    case "layer.text": {
      const id = newId("l", taken(doc));
      const text = String(args.text).slice(0, 400);
      const layer: Layer = { id, kind: "text", name: text.slice(0, 24) || "Text" };
      const bad = insertAbove(t, layer);
      if (bad) return fail(bad);
      p[`layer.${id}.text`] = text;
      p[`layer.${id}.x`] = numArg(args.x, 0.5, -0.5, 1.5);
      p[`layer.${id}.y`] = numArg(args.y, 0.5, -0.5, 1.5);
      p[`layer.${id}.size`] = numArg(args.size, 8, 1, 60);
      p[`layer.${id}.color`] = colorArg(args.color, colorArg(p.color, "#ffffff"));
      if (typeof args.font === "string" && (FONTS as readonly string[]).includes(args.font)) p[`layer.${id}.font`] = args.font;
      return { ok: true, said: `Added text layer ${id} "${layer.name}".`, layer: id };
    }
    case "layer.place": {
      const art = String(args.artifact);
      if (!/^[\w-]{1,80}$/.test(art)) return fail("artifact is the picture's artifact id.");
      const id = newId("l", taken(doc));
      const layer: Layer = { id, kind: "image", name: typeof args.name === "string" ? args.name.slice(0, 40) : "Picture", artifact: art };
      const bad = insertAbove(t, layer);
      if (bad) return fail(bad);
      p[`layer.${id}.x`] = numArg(args.x, 0.5, -0.5, 1.5);
      p[`layer.${id}.y`] = numArg(args.y, 0.5, -0.5, 1.5);
      p[`layer.${id}.scale`] = numArg(args.scale, 0.5, 0.05, 8);
      return { ok: true, said: `Placed the picture on layer ${id}.`, layer: id };
    }
    case "layer.paint": {
      const pts = flat(args.points);
      if (!pts) return fail("Give the points the brush goes through.");
      const l = paintLayer(t);
      if (typeof l === "string") return fail(l);
      l.strokes = [...(l.strokes ?? []), {
        points: thinPoints(pts), size: numArg(args.size, numArg(p["tool.size"], 4), 0.2, 40) / 100, color: colorArg(args.color, colorArg(p.color, "#ffffff")),
        opacity: numArg(args.opacity, numArg(p["tool.opacity"], 100), 1, 100) / 100, hardness: numArg(p["tool.hardness"], 70, 0, 100) / 100,
      }].slice(-MAX_STROKES);
      return { ok: true, said: `Painted a stroke on ${l.name}.`, layer: l.id };
    }
    case "layer.erase_stroke": {
      const pts = flat(args.points);
      if (!pts) return fail("Give the points the eraser goes through.");
      const l = layerFor(doc, null)!;
      const s: Selection = { ops: [{ op: "add", shape: { type: "stroke", points: thinPoints(pts), size: numArg(args.size, numArg(p["tool.size"], 4), 0.2, 40) / 100, hardness: numArg(p["tool.hardness"], 70, 0, 100) / 100 } }], feather: 0, grow: 0, invert: false };
      l.mask = [...(l.mask ?? []), { op: "subtract" as const, sel: s }].slice(-MAX_STROKES);
      return { ok: true, said: `Erased along the stroke on ${l.name}.` };
    }
    case "layer.new": {
      const id = newId("l", taken(doc));
      const layer: Layer = { id, kind: "paint", name: typeof args.name === "string" && args.name.trim() ? args.name.trim().slice(0, 40) : "Layer", strokes: [] };
      const bad = insertAbove(t, layer);
      return bad ? fail(bad) : { ok: true, said: `Added an empty layer ${id}.`, layer: id };
    }
    case "layer.select": {
      const l = doc.layers.find((x) => x.id === args.id);
      if (!l) return fail(`There is no layer "${String(args.id)}". Layers: ${doc.layers.map((x) => `${x.id} "${x.name}"`).join(", ")}.`);
      doc.active = l.id;
      return { ok: true, said: `${l.name} is the active layer.` };
    }
    case "layer.rename": {
      const l = layerFor(doc, args.id);
      if (!l) return fail(`There is no layer "${String(args.id)}".`);
      l.name = String(args.name).trim().slice(0, 40) || l.name;
      return { ok: true, said: `Renamed it "${l.name}".` };
    }
    case "layer.up": case "layer.down": {
      const l = layerFor(doc, args.id);
      if (!l) return fail(`There is no layer "${String(args.id)}".`);
      const i = doc.layers.indexOf(l);
      const j = name === "layer.up" ? i + 1 : i - 1;
      if (l.kind === "photo" || j < 1 || j >= doc.layers.length) return fail(l.kind === "photo" ? "The photo stays at the bottom." : `${l.name} is already the ${name === "layer.up" ? "top" : "lowest above the photo"}.`);
      doc.layers.splice(i, 1);
      doc.layers.splice(j, 0, l);
      return { ok: true, said: `Moved ${l.name} ${name === "layer.up" ? "up" : "down"}.` };
    }
    case "layer.delete": {
      const l = layerFor(doc, args.id);
      if (!l) return fail(`There is no layer "${String(args.id)}".`);
      if (l.kind === "photo") return fail("The photo is the picture itself; hide it (its eye) or erase parts of it instead.");
      const users = doc.layers.filter((x) => x.of === l.id);
      if (users.length) return fail(`${users.map((u) => u.name).join(", ")} ${users.length === 1 ? "is a copy" : "are copies"} of ${l.name}; delete ${users.length === 1 ? "it" : "them"} first.`);
      doc.layers = doc.layers.filter((x) => x.id !== l.id);
      dropParams(p, `layer.${l.id}.`);
      if (doc.active === l.id) doc.active = doc.layers.at(-1)!.id;
      return { ok: true, said: `Deleted layer ${l.name}.` };
    }
    case "layer.mask_clear": {
      const l = layerFor(doc, args.id);
      if (!l) return fail(`There is no layer "${String(args.id)}".`);
      if (l.kind === "copy" || l.kind === "heal") return fail(`${l.name}'s mask is what it is made of; delete the layer instead.`);
      delete l.mask;
      return { ok: true, said: `${l.name} shows everywhere again.` };
    }

    case "mask.add": {
      if (doc.masks.length >= MAX_MASKS) return fail(`A picture takes ${MAX_MASKS} local adjustments; delete one or set the whole picture instead.`);
      const id = newId("m", taken(doc));
      doc.masks.push({ id, name: typeof args.name === "string" && args.name.trim() ? args.name.trim().slice(0, 30) : `Adjustment ${doc.masks.length + 1}`, sel: frozen(sel!) });
      const set: string[] = [];
      for (const mp of MASK_PARAMS) {
        const v = args[mp.name];
        if (typeof v === "number" && Number.isFinite(v)) { p[`mask.${id}.${mp.name}`] = Math.min(mp.max!, Math.max(mp.min!, v)); set.push(`${mp.name} ${v}`); }
      }
      return { ok: true, said: `Kept the selection as local adjustment ${id}${set.length ? ` with ${set.join(", ")}` : ""}: its sliders are mask.${id}.<${MASK_PARAMS.map((x) => x.name).join("|")}>.`, mask: id };
    }
    case "mask.delete": {
      const m = doc.masks.find((x) => x.id === args.id);
      if (!m) return fail(`There is no adjustment "${String(args.id)}".`);
      doc.masks = doc.masks.filter((x) => x.id !== m.id);
      dropParams(p, `mask.${m.id}.`);
      return { ok: true, said: `Deleted the adjustment ${m.name}.` };
    }

    case "image.crop": {
      const x = numArg(args.x, 0, 0, 1); const y = numArg(args.y, 0, 0, 1);
      const w = numArg(args.w, 1, 0.01, 1 - x); const h = numArg(args.h, 1, 0.01, 1 - y);
      p.crop = [r4(x), r4(y), r4(w), r4(h)];
      return { ok: true, said: "Cropped." };
    }
    case "image.crop_selection": {
      const b = (env.bounds ?? shapeBounds)(sel!);
      if (!b) return fail(env.bounds ? "Nothing is selected to crop to." : "Where this selection is depends on the picture's pixels: open the Panacea window to crop to it, or crop with image.crop.", !env.bounds);
      if (!t.px) return fail("The picture's size is not known yet.", true);
      // The frame in output space before cropping: the selection's corners mapped there.
      const corners = [[b.x, b.y], [b.x + b.w, b.y], [b.x, b.y + b.h], [b.x + b.w, b.y + b.h]].map(([cx, cy]) => toOutput(p, t.px!, cx!, cy!, true));
      const xs = corners.map((c) => Math.min(1, Math.max(0, c[0])));
      const ys = corners.map((c) => Math.min(1, Math.max(0, c[1])));
      const x0 = Math.min(...xs); const y0 = Math.min(...ys);
      const w = Math.max(...xs) - x0; const h = Math.max(...ys) - y0;
      if (w < 0.005 || h < 0.005) return fail("The selection is outside the frame.");
      p.crop = [r4(x0), r4(y0), r4(w), r4(h)];
      doc.selection = [];
      return { ok: true, said: "Cropped to the selection." };
    }
    case "image.uncrop": p.crop = [0, 0, 1, 1]; return { ok: true, said: "The whole frame is back." };
    case "reset": case "auto": case "export":
      // The develop sliders are the surface's (surfaces.ts runs these): here only for the index.
      return fail(`${name} is run by the surface.`);
  }
  return fail(`${name} is not done here.`);
}

// ------------------------------------------------------------- checking --

const isSel = (v: unknown): v is Selection => !!v && typeof v === "object" && Array.isArray((v as Selection).ops);

function readShape(raw: unknown): Shape | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  const n = (v: unknown, lo = -2, hi = 3) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : null);
  switch (s.type) {
    case "all": return { type: "all" };
    case "rect": case "ellipse": {
      const [x, y, w, h] = [n(s.x), n(s.y), n(s.w, 0, 3), n(s.h, 0, 3)];
      return x === null || y === null || w === null || h === null ? null : { type: s.type, x, y, w, h };
    }
    case "polygon": { const pts = flat(s.points); return pts ? { type: "polygon", points: pts } : null; }
    case "stroke": { const pts = flat(s.points); const size = n(s.size, 0.001, 0.5); return pts && size !== null ? { type: "stroke", points: pts, size, ...(n(s.hardness, 0, 1) !== null ? { hardness: n(s.hardness, 0, 1)! } : {}) } : null; }
    case "wand": { const [x, y] = [n(s.x, 0, 1), n(s.y, 0, 1)]; return x === null || y === null ? null : { type: "wand", x, y, tolerance: n(s.tolerance, 0, 100) ?? 24, contiguous: s.contiguous !== false }; }
    case "color": return { type: "color", ...(typeof s.color === "string" && /^#[0-9a-f]{6}$/i.test(s.color) ? { color: s.color } : { x: n(s.x, 0, 1) ?? 0.5, y: n(s.y, 0, 1) ?? 0.5 }), range: n(s.range, 0, 100) ?? 24 };
    case "object": { const [x, y] = [n(s.x, 0, 1), n(s.y, 0, 1)]; return x === null || y === null ? null : { type: "object", x, y, ...(typeof s.mask === "string" && /^[\w-]{1,80}$/.test(s.mask) ? { mask: s.mask } : {}) }; }
  }
  return null;
}

function readOps(raw: unknown): SelOp[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(-MAX_OPS).map((o) => {
    const r = o as Record<string, unknown> | null;
    const shape = readShape(r?.shape);
    const op = r?.op === "subtract" || r?.op === "intersect" ? r.op : "add";
    return shape ? { op, shape } : null;
  }).filter((o): o is SelOp => o !== null);
}

function readSel(raw: unknown): Selection | null {
  if (!isSel(raw)) return null;
  const ops = readOps(raw.ops);
  if (!ops.length) return null;
  return { ops, feather: Math.min(250, Math.max(0, Number(raw.feather) || 0)), grow: Math.min(100, Math.max(-100, Number(raw.grow) || 0)), invert: raw.invert === true };
}

const KINDS: LayerKind[] = ["photo", "copy", "image", "fill", "paint", "text", "heal"];

/** A photo's model from anywhere (disk, the page, an old canvas with none), checked and repaired. */
export function normalizeImageDoc(raw: unknown): ImageDoc {
  const out = newImageDoc();
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Record<string, unknown>;
  const ids = new Set<string>(["photo"]);
  const layers: Layer[] = [];
  const rawLayers = Array.isArray(r.layers) ? r.layers.slice(0, MAX_LAYERS) : [];
  const photo = rawLayers.find((l) => (l as Layer | null)?.kind === "photo") as Layer | undefined;
  layers.push({ id: "photo", kind: "photo", name: typeof photo?.name === "string" ? photo.name.slice(0, 40) : "Photo", ...(Array.isArray(photo?.mask) ? { mask: photo!.mask.map((m) => ({ op: m?.op === "subtract" ? "subtract" as const : "add" as const, sel: readSel(m?.sel) })).filter((m): m is MaskEntry => m.sel !== null) } : {}) });
  for (const l of rawLayers) {
    const x = l as Record<string, unknown> | null;
    if (!x || typeof x.id !== "string" || !/^[\w-]{1,40}$/.test(x.id) || ids.has(x.id) || !KINDS.includes(x.kind as LayerKind) || x.kind === "photo") continue;
    ids.add(x.id);
    const mask = Array.isArray(x.mask) ? x.mask.map((m: Record<string, unknown>) => ({ op: m?.op === "subtract" ? "subtract" as const : "add" as const, sel: readSel(m?.sel) })).filter((m): m is MaskEntry => m.sel !== null) : undefined;
    const strokes = x.kind === "paint" && Array.isArray(x.strokes) ? x.strokes.slice(-MAX_STROKES).map((s: Record<string, unknown>) => {
      const pts = flat(s?.points);
      return pts ? { points: pts, size: Math.min(0.5, Math.max(0.001, Number(s.size) || 0.04)), color: colorArg(s.color, "#ffffff"), opacity: Math.min(1, Math.max(0.01, Number(s.opacity) || 1)), hardness: Math.min(1, Math.max(0, Number(s.hardness ?? 0.7))) } : null;
    }).filter((s): s is Stroke => s !== null) : undefined;
    layers.push({
      id: x.id, kind: x.kind as LayerKind, name: typeof x.name === "string" ? x.name.slice(0, 40) : "Layer",
      ...(typeof x.of === "string" ? { of: x.of } : {}),
      ...(typeof x.artifact === "string" && /^[\w-]{1,80}$/.test(x.artifact) ? { artifact: x.artifact } : {}),
      ...(mask ? { mask } : {}), ...(strokes ? { strokes } : {}),
    });
  }
  // A copy of a layer that is gone goes with it.
  out.layers = layers.filter((l) => l.kind !== "copy" || ids.has(l.of ?? "photo"));
  out.active = typeof r.active === "string" && out.layers.some((l) => l.id === r.active) ? r.active : out.layers.at(-1)!.id;
  out.masks = Array.isArray(r.masks) ? r.masks.slice(0, MAX_MASKS).map((m: Record<string, unknown>) => {
    const sel = readSel(m?.sel);
    if (!sel || typeof m.id !== "string" || !/^[\w-]{1,40}$/.test(m.id) || ids.has(m.id)) return null;
    ids.add(m.id);
    return { id: m.id, name: typeof m.name === "string" ? m.name.slice(0, 30) : "Adjustment", sel };
  }).filter((m): m is Adjustment => m !== null) : [];
  out.selection = readOps(r.selection);
  return out;
}

/** The photo's model in words, for the agent. */
export function imageWords(doc: ImageDoc, params: Record<string, Value>): string {
  const layers = [...doc.layers].reverse().map((l) => {
    const hidden = params[`layer.${l.id}.visible`] === false ? ", hidden" : "";
    const op = typeof params[`layer.${l.id}.opacity`] === "number" && params[`layer.${l.id}.opacity`] !== 100 ? `, ${String(params[`layer.${l.id}.opacity`])}%` : "";
    const blend = params[`layer.${l.id}.blend`] && params[`layer.${l.id}.blend`] !== "normal" ? `, ${String(params[`layer.${l.id}.blend`])}` : "";
    const what = l.kind === "text" ? ` "${String(params[`layer.${l.id}.text`] ?? "").slice(0, 30)}"` : l.kind === "paint" ? ` ${l.strokes?.length ?? 0} strokes` : "";
    return `${l.id} ${l.kind} "${l.name}"${what}${hidden}${op}${blend}${l.mask?.length ? `, masked (${l.mask.length})` : ""}${l.id === doc.active ? " [active]" : ""}`;
  });
  const masks = doc.masks.map((m) => {
    const set = MASK_PARAMS.map((mp) => [mp.name, params[`mask.${m.id}.${mp.name}`]] as const).filter(([k, v]) => typeof v === "number" && v !== (k === "amount" ? 100 : 0)).map(([k, v]) => `${k} ${String(v)}`);
    return `${m.id} "${m.name}" (${selectionWords(m.sel)})${set.length ? `: ${set.join(", ")}` : ""}`;
  });
  return [
    `Layers, top first: ${layers.join("; ")}.`,
    masks.length ? `Local adjustments: ${masks.join("; ")}.` : "",
    `Selection: ${selectionWords(selectionOf(doc, params))}.`,
    `Tool: ${String(params.tool ?? "pointer")}.`,
  ].filter(Boolean).join(" ");
}

/**
 * A command's points given as the agent sees them (0..1 across the picture as shown, crop and rotation and all) made
 * points on the photo. A box stays a box while the picture is square to the photo; tilted, it becomes the polygon it
 * covers. `image.crop` stays as it is: it is a frame on the picture as shown.
 */
export function fromShown(t: ImageTarget, name: string, args: Record<string, unknown>): { name: string; args: Record<string, unknown> } {
  if (!t.px) return { name, args };
  const px = t.px;
  const at = (x: unknown, y: unknown): [number, number] => toSource(t.params, px, Number(x), Number(y));
  const out: Record<string, unknown> = { ...args };
  const isNum = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  if ((name === "select.rect" || name === "select.ellipse") && [args.x, args.y, args.w, args.h].every(isNum)) {
    const x = args.x as number; const y = args.y as number; const w = args.w as number; const h = args.h as number;
    if (n0(t.params.straighten) === 0) {
      const [ax, ay] = at(x, y); const [bx, by] = at(x + w, y + h);
      return { name, args: { ...out, x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) } };
    }
    const ring: Array<[number, number]> = name === "select.rect"
      ? [at(x, y), at(x + w, y), at(x + w, y + h), at(x, y + h)]
      : Array.from({ length: 48 }, (_, k) => { const a = (k / 48) * Math.PI * 2; return at(x + w / 2 + (Math.cos(a) * w) / 2, y + h / 2 + (Math.sin(a) * h) / 2); });
    return { name: "select.polygon", args: { points: ring, ...(args.mode ? { mode: args.mode } : {}) } };
  }
  if (Array.isArray(args.points)) out.points = (args.points as unknown[]).map((p) => (Array.isArray(p) && p.length === 2 ? at(p[0], p[1]) : p));
  if (isNum(args.x) && isNum(args.y) && name !== "image.crop") { const [x, y] = at(args.x, args.y); out.x = x; out.y = y; }
  return { name, args: out };
}
