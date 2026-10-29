/**
 * A photo's layers put together, in the page: what the renderer (imagegl.ts) then develops.
 *
 * Bottom to top, each visible layer is drawn at the working size (the photo; a copy of a layer's pixels, moved; a placed
 * picture; a fill; brush strokes; text; a healed patch, filled from what is under it), cut to its layer mask, and laid on
 * the others at its opacity and blend mode. The masks of the selection and of the local adjustments are rasterized
 * here too (src/lib/panacea/mask.ts), from the photo's own pixels where a tool needs them (the wand, colour range).
 *
 * Everything is cached by what it was made from, so a slider that moves only the develop settings never recomposes.
 */
import type { Value } from "../../lib/panacea/atoms";
import { selectionOf, type ImageDoc, type Layer, type MaskEntry, type Selection } from "../../lib/panacea/image";
import { heal, maskBounds, rasterize, type MaskSource, type Pixels } from "../../lib/panacea/mask";
import type { MaskLayer } from "./imagegl";

type Canvas2D = HTMLCanvasElement;

const FONT_FAMILY: Record<string, string> = {
  sans: "system-ui, -apple-system, \"Segoe UI\", Roboto, sans-serif",
  serif: "Georgia, \"Times New Roman\", serif",
  mono: "ui-monospace, Menlo, Consolas, monospace",
  display: "Impact, \"Arial Black\", sans-serif",
  hand: "\"Segoe Print\", \"Comic Sans MS\", cursive",
};

const num = (v: Value | undefined, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);

function canvas(w: number, h: number): Canvas2D {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

const ctx2d = (c: Canvas2D) => c.getContext("2d", { willReadFrequently: true })!;

/** The size the picture is worked on at: the photo, its long side at most `max`. */
export function workSize(px: { w: number; h: number }, max = 2048): { w: number; h: number; scale: number } {
  const scale = Math.min(1, max / Math.max(px.w, px.h));
  return { w: Math.max(1, Math.round(px.w * scale)), h: Math.max(1, Math.round(px.h * scale)), scale };
}

/** A mask as a canvas: white where it holds, for `destination-in`. */
function maskCanvas(m: Uint8Array, w: number, h: number): Canvas2D {
  const c = canvas(w, h);
  const img = new ImageData(w, h);
  for (let i = 0; i < w * h; i++) { img.data[i * 4] = 255; img.data[i * 4 + 1] = 255; img.data[i * 4 + 2] = 255; img.data[i * 4 + 3] = m[i]!; }
  ctx2d(c).putImageData(img, 0, 0);
  return c;
}

/** The picture's sources: the photo, placed pictures by artifact, and masks the model made. */
interface Sources {
  photo: CanvasImageSource & { width: number; height: number };
  picture: (artifact: string) => (CanvasImageSource & { width: number; height: number }) | null;
  mask: MaskSource;
}

/**
 * One photo's working state in the page: its pixels at the working size and what has been made from them, cached by
 * what they were made from.
 */
export class Picture {
  private pixelsAt: { key: string; px: Pixels } | null = null;
  private cache = new Map<string, unknown>();

  constructor(private src: Sources) {}

  /** The photo's pixels at a size: what the wand and colour range read. */
  pixels(w: number, h: number): Pixels {
    const key = `${w}x${h}`;
    if (this.pixelsAt?.key !== key) {
      const c = canvas(w, h);
      const g = ctx2d(c);
      g.drawImage(this.src.photo, 0, 0, w, h);
      const d = g.getImageData(0, 0, w, h);
      this.pixelsAt = { key, px: { w, h, data: d.data } };
    }
    return this.pixelsAt.px;
  }

  /** A cached value made once per key; the cache keeps the last few. */
  private memo<T>(key: string, make: () => T): T {
    if (this.cache.has(key)) return this.cache.get(key) as T;
    const v = make();
    this.cache.set(key, v);
    if (this.cache.size > 24) this.cache.delete(this.cache.keys().next().value!);
    return v;
  }

  /** A selection as a mask at a size. `scale` is that size over the photo's. */
  raster(sel: Selection, w: number, h: number, scale: number): Uint8Array {
    return this.memo(`sel:${w}x${h}:${JSON.stringify(sel)}`, () => rasterize(sel, w, h, this.pixels(w, h), this.src.mask, scale));
  }

  /** Where a layer shows, or null for everywhere. */
  private layerMask(entries: MaskEntry[] | undefined, w: number, h: number, scale: number): Uint8Array | null {
    if (!entries?.length) return null;
    return this.memo(`lm:${w}x${h}:${JSON.stringify(entries)}`, () => {
      const out = new Uint8Array(w * h);
      if (entries[0]!.op === "subtract") out.fill(255);
      for (const e of entries) {
        const m = this.raster(e.sel, w, h, scale);
        for (let i = 0; i < out.length; i++) out[i] = e.op === "add" ? Math.max(out[i]!, m[i]!) : Math.min(out[i]!, 255 - m[i]!);
      }
      return out;
    });
  }

  /** The current selection at a size, or null. */
  selection(doc: ImageDoc, params: Record<string, Value>, w: number, h: number, scale: number): Uint8Array | null {
    const sel = selectionOf(doc, params);
    return sel ? this.raster(sel, w, h, scale) : null;
  }

  /** The local adjustments' masks at a size. */
  masks(doc: ImageDoc, w: number, h: number, scale: number): MaskLayer[] {
    return doc.masks.map((m) => ({ id: m.id, data: this.raster(m.sel, w, h, scale), w, h, key: `${w}x${h}:${JSON.stringify(m.sel)}` }));
  }

  /** Whether the layers need putting together at all: a lone photo shown everywhere is the photo. */
  static plain(doc: ImageDoc, params: Record<string, Value>): boolean {
    const photo = doc.layers[0]!;
    return doc.layers.length === 1 && !photo.mask?.length && params["layer.photo.visible"] !== false && num(params["layer.photo.opacity"], 100) >= 100;
  }

  /** What a layer's look depends on, for the cache. */
  private static layerKey(l: Layer, params: Record<string, Value>): string {
    const own = Object.entries(params).filter(([k]) => k.startsWith(`layer.${l.id}.`));
    return JSON.stringify([l, own]);
  }

  /** The layers put together at a size. */
  compose(doc: ImageDoc, params: Record<string, Value>, w: number, h: number, scale: number): Canvas2D {
    const key = `c:${w}x${h}:${doc.layers.map((l) => Picture.layerKey(l, params)).join("|")}`;
    return this.memo(key, () => {
      const out = canvas(w, h);
      const o = ctx2d(out);
      for (const l of doc.layers) {
        if (params[`layer.${l.id}.visible`] === false) continue;
        const layer = this.draw(l, doc, params, w, h, scale, out);
        if (!layer) continue;
        o.globalAlpha = Math.min(1, Math.max(0, num(params[`layer.${l.id}.opacity`], 100) / 100));
        const blend = String(params[`layer.${l.id}.blend`] ?? "normal");
        o.globalCompositeOperation = (blend === "normal" ? "source-over" : blend) as GlobalCompositeOperation;
        o.drawImage(layer, 0, 0);
      }
      o.globalAlpha = 1;
      o.globalCompositeOperation = "source-over";
      return out;
    });
  }

  /** One layer drawn on its own, cut to its mask. `below` is what the layers under it make (Heal reads it). */
  private draw(l: Layer, doc: ImageDoc, params: Record<string, Value>, w: number, h: number, scale: number, below: Canvas2D): Canvas2D | null {
    const p = (k: string, d: number) => num(params[`layer.${l.id}.${k}`], d);
    const c = canvas(w, h);
    const g = ctx2d(c);
    const mask = this.layerMask(l.mask, w, h, scale);
    const cut = (m: Uint8Array | null) => {
      if (!m) return;
      g.globalCompositeOperation = "destination-in";
      g.drawImage(maskCanvas(m, w, h), 0, 0);
      g.globalCompositeOperation = "source-over";
    };
    switch (l.kind) {
      case "photo":
        g.drawImage(this.src.photo, 0, 0, w, h);
        cut(mask);
        return c;
      case "copy": {
        const from = doc.layers.find((x) => x.id === (l.of ?? "photo"));
        if (!from) return null;
        // The source's pixels as they are on their own (not its mask), cut to the copy's shape, then moved.
        const src = from.kind === "photo" ? null : this.draw({ ...from, mask: undefined }, doc, params, w, h, scale, below);
        const piece = canvas(w, h);
        const pg = ctx2d(piece);
        if (src) pg.drawImage(src, 0, 0); else pg.drawImage(this.src.photo, 0, 0, w, h);
        if (mask) { pg.globalCompositeOperation = "destination-in"; pg.drawImage(maskCanvas(mask, w, h), 0, 0); }
        const b = mask ? maskBounds(mask, w, h) : null;
        const cx = b ? (b.x + b.w / 2) * w : w / 2;
        const cy = b ? (b.y + b.h / 2) * h : h / 2;
        g.translate(cx + p("dx", 0) * w, cy + p("dy", 0) * h);
        g.rotate((p("angle", 0) * Math.PI) / 180);
        g.scale(p("scale", 1), p("scale", 1));
        g.drawImage(piece, -cx, -cy);
        return c;
      }
      case "image": {
        const img = l.artifact ? this.src.picture(l.artifact) : null;
        if (!img) return null;
        const iw = w * p("scale", 0.5);
        const ih = (iw * img.height) / Math.max(1, img.width);
        g.translate(p("x", 0.5) * w, p("y", 0.5) * h);
        g.rotate((p("angle", 0) * Math.PI) / 180);
        g.drawImage(img, -iw / 2, -ih / 2, iw, ih);
        g.setTransform(1, 0, 0, 1, 0, 0);
        cut(mask);
        return c;
      }
      case "fill":
        g.fillStyle = String(params[`layer.${l.id}.color`] ?? "#000000");
        g.fillRect(0, 0, w, h);
        cut(mask);
        return c;
      case "paint": {
        const long = Math.max(w, h);
        g.translate(p("dx", 0) * w, p("dy", 0) * h);
        g.lineCap = "round";
        g.lineJoin = "round";
        for (const s of l.strokes ?? []) {
          // A soft brush is the stroke drawn on its own and blurred by how soft it is.
          const soft = (1 - s.hardness) * s.size * long * 0.5;
          const layer = soft > 0.5 ? canvas(w, h) : c;
          const sg = layer === c ? g : ctx2d(layer);
          sg.save();
          if (layer !== c) sg.setTransform(g.getTransform());
          sg.strokeStyle = s.color;
          sg.fillStyle = s.color;
          sg.lineWidth = Math.max(1, s.size * long - soft);
          sg.globalAlpha = layer === c ? s.opacity : 1;
          sg.beginPath();
          for (let i = 0; i < s.points.length; i += 2) {
            const x = s.points[i]! * w; const y = s.points[i + 1]! * h;
            if (i === 0) sg.moveTo(x, y); else sg.lineTo(x, y);
          }
          if (s.points.length === 2) { sg.arc(s.points[0]! * w, s.points[1]! * h, sg.lineWidth / 2, 0, Math.PI * 2); sg.fill(); } else sg.stroke();
          sg.restore();
          if (layer !== c) {
            g.save();
            g.setTransform(1, 0, 0, 1, 0, 0);
            g.globalAlpha = s.opacity;
            g.filter = `blur(${soft.toFixed(1)}px)`;
            g.drawImage(layer, 0, 0);
            g.restore();
          }
        }
        g.setTransform(1, 0, 0, 1, 0, 0);
        cut(mask);
        return c;
      }
      case "text": {
        const text = String(params[`layer.${l.id}.text`] ?? "");
        if (!text.trim()) return null;
        const size = (p("size", 8) / 100) * h;
        const font = FONT_FAMILY[String(params[`layer.${l.id}.font`] ?? "sans")] ?? FONT_FAMILY.sans!;
        const align = String(params[`layer.${l.id}.align`] ?? "center") as CanvasTextAlign;
        g.translate(p("x", 0.5) * w, p("y", 0.5) * h);
        g.rotate((p("angle", 0) * Math.PI) / 180);
        g.scale(p("scale", 1), p("scale", 1));
        g.font = `${params[`layer.${l.id}.bold`] === false ? 400 : 700} ${size.toFixed(1)}px ${font}`;
        g.textAlign = align;
        g.textBaseline = "middle";
        g.fillStyle = String(params[`layer.${l.id}.color`] ?? "#ffffff");
        if (params[`layer.${l.id}.shadow`] === true) { g.shadowColor = "rgba(0,0,0,0.55)"; g.shadowBlur = size * 0.18; g.shadowOffsetY = size * 0.05; }
        const lines = text.split("\n");
        lines.forEach((line, i) => g.fillText(line, 0, (i - (lines.length - 1) / 2) * size * 1.18));
        g.setTransform(1, 0, 0, 1, 0, 0);
        cut(mask);
        return c;
      }
      case "heal": {
        if (!mask) return null;
        // What is under it, filled in where it is masked.
        const under = ctx2d(below).getImageData(0, 0, w, h);
        const px: Pixels = { w, h, data: under.data };
        heal(px, mask);
        g.putImageData(under, 0, 0);
        const shaped = new Uint8Array(mask.length);
        for (let i = 0; i < mask.length; i++) shaped[i] = mask[i]! > 0 ? Math.min(255, mask[i]! * 2) : 0;
        cut(shaped);
        return c;
      }
    }
  }
}
