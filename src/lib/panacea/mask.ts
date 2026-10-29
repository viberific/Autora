/**
 * Selections as pixels: the image engine's rasterizer (src/lib/panacea/image.ts keeps a selection as a list of shapes;
 * this turns that list into a mask, one byte a pixel, 0 outside and 255 inside).
 *
 * Every tool's shape is here: a rectangle, an ellipse, a polygon (the lasso and the polygon lasso), a brushed stroke
 * (quick select, the eraser, the heal brush, a painted mask), a magic wand's flood, a colour range, and a mask made
 * elsewhere (an object the segmentation model picked). Then what is done to a selection as a whole: add, subtract and
 * intersect, grow or shrink, feather, invert. And `heal`, which fills a masked part of a picture from what is around it
 * (Remove).
 *
 * Coordinates are 0..1 across the photo (its own pixels, before crop and rotation), so the same selection is drawn at the
 * preview's size and again at full size for an export. Pure: typed arrays in and out, so it is tested in Node and run
 * in the page.
 */
import type { Selection, Shape } from "./image";

/** RGBA pixels, as a canvas's ImageData holds them. */
export interface Pixels {
  w: number;
  h: number;
  data: Uint8ClampedArray | Uint8Array;
}

/** A mask made elsewhere (an object picked by the model), as the page has it at this size. */
export type MaskSource = (id: string, w: number, h: number) => Uint8Array | null;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Every pixel whose centre is inside the box. */
function rect(out: Uint8Array, w: number, h: number, s: { x: number; y: number; w: number; h: number }) {
  const x0 = clamp(Math.round(s.x * w), 0, w);
  const x1 = clamp(Math.round((s.x + s.w) * w), 0, w);
  const y0 = clamp(Math.round(s.y * h), 0, h);
  const y1 = clamp(Math.round((s.y + s.h) * h), 0, h);
  for (let y = y0; y < y1; y++) out.fill(255, y * w + x0, y * w + x1);
}

function ellipse(out: Uint8Array, w: number, h: number, s: { x: number; y: number; w: number; h: number }) {
  const cx = (s.x + s.w / 2) * w;
  const cy = (s.y + s.h / 2) * h;
  const rx = Math.max(0.5, (s.w / 2) * w);
  const ry = Math.max(0.5, (s.h / 2) * h);
  const y0 = clamp(Math.floor(cy - ry), 0, h);
  const y1 = clamp(Math.ceil(cy + ry), 0, h);
  for (let y = y0; y < y1; y++) {
    const dy = (y + 0.5 - cy) / ry;
    if (dy * dy > 1) continue;
    const half = Math.sqrt(1 - dy * dy) * rx;
    const a = clamp(Math.round(cx - half), 0, w);
    const b = clamp(Math.round(cx + half), 0, w);
    out.fill(255, y * w + a, y * w + b);
  }
}

/** Even-odd scanline fill: what the lasso and the polygon lasso close. */
function polygon(out: Uint8Array, w: number, h: number, pts: number[]) {
  const n = Math.floor(pts.length / 2);
  if (n < 3) return;
  const xs: number[] = [];
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < n; i++) { const y = pts[i * 2 + 1]! * h; lo = Math.min(lo, y); hi = Math.max(hi, y); }
  const y0 = clamp(Math.floor(lo), 0, h);
  const y1 = clamp(Math.ceil(hi), 0, h);
  for (let y = y0; y < y1; y++) {
    const sy = y + 0.5;
    xs.length = 0;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const ax = pts[i * 2]! * w; const ay = pts[i * 2 + 1]! * h;
      const bx = pts[j * 2]! * w; const by = pts[j * 2 + 1]! * h;
      if ((ay > sy) !== (by > sy)) xs.push(ax + ((sy - ay) / (by - ay)) * (bx - ax));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const a = clamp(Math.round(xs[k]!), 0, w);
      const b = clamp(Math.round(xs[k + 1]!), 0, w);
      if (b > a) out.fill(255, y * w + a, y * w + b);
    }
  }
}

/**
 * A brushed line: every pixel within half the brush of it, with a soft edge set by `hardness` (0..1). `size` is the
 * brush's width as a share of the picture's long side. Strength is kept as the most any segment gives.
 */
function stroke(out: Uint8Array, w: number, h: number, pts: number[], size: number, hardness = 1, strength = 255) {
  const n = Math.floor(pts.length / 2);
  if (!n) return;
  const r = Math.max(0.5, (size * Math.max(w, h)) / 2);
  const core = r * clamp(hardness, 0, 1);
  const seg = (ax: number, ay: number, bx: number, by: number) => {
    const x0 = clamp(Math.floor(Math.min(ax, bx) - r), 0, w);
    const x1 = clamp(Math.ceil(Math.max(ax, bx) + r), 0, w);
    const y0 = clamp(Math.floor(Math.min(ay, by) - r), 0, h);
    const y1 = clamp(Math.ceil(Math.max(ay, by) + r), 0, h);
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy || 1e-9;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const px = x + 0.5 - ax;
        const py = y + 0.5 - ay;
        const t = clamp((px * dx + py * dy) / len2, 0, 1);
        const d = Math.hypot(px - t * dx, py - t * dy);
        if (d >= r) continue;
        const a = d <= core ? 1 : 1 - (d - core) / Math.max(1e-6, r - core);
        const v = Math.round(a * strength);
        const i = y * w + x;
        if (v > out[i]!) out[i] = v;
      }
    }
  };
  if (n === 1) seg(pts[0]! * w, pts[1]! * h, pts[0]! * w, pts[1]! * h);
  for (let i = 1; i < n; i++) seg(pts[(i - 1) * 2]! * w, pts[(i - 1) * 2 + 1]! * h, pts[i * 2]! * w, pts[i * 2 + 1]! * h);
}

const rgbAt = (px: Pixels, x: number, y: number): [number, number, number] => {
  const i = (y * px.w + x) * 4;
  return [px.data[i]!, px.data[i + 1]!, px.data[i + 2]!];
};

/** The picture's pixels sampled at this mask's size (nearest), so a wand at preview size and at full size agree. */
function sampler(px: Pixels, w: number, h: number) {
  return (x: number, y: number) => rgbAt(px, Math.min(px.w - 1, Math.floor(((x + 0.5) * px.w) / w)), Math.min(px.h - 1, Math.floor(((y + 0.5) * px.h) / h)));
}

/**
 * The magic wand: every pixel within `tolerance` (0..100) of the colour where it was clicked, joined to it (contiguous)
 * or anywhere in the picture.
 */
function wand(out: Uint8Array, w: number, h: number, px: Pixels, s: { x: number; y: number; tolerance: number; contiguous: boolean }) {
  const at = sampler(px, w, h);
  const sx = clamp(Math.floor(s.x * w), 0, w - 1);
  const sy = clamp(Math.floor(s.y * h), 0, h - 1);
  const [r0, g0, b0] = at(sx, sy);
  const tol = clamp(s.tolerance, 0, 100) * 2.55;
  const near = (x: number, y: number) => {
    const [r, g, b] = at(x, y);
    return Math.max(Math.abs(r - r0), Math.abs(g - g0), Math.abs(b - b0)) <= tol;
  };
  if (!s.contiguous) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (near(x, y)) out[y * w + x] = 255;
    return;
  }
  // Scanline flood fill.
  const seen = new Uint8Array(w * h);
  const stack: number[] = [sx, sy];
  while (stack.length) {
    const y = stack.pop()!;
    let x = stack.pop()!;
    if (seen[y * w + x]) continue;
    while (x > 0 && !seen[y * w + x - 1] && near(x - 1, y)) x--;
    let up = false;
    let down = false;
    for (; x < w && !seen[y * w + x] && near(x, y); x++) {
      seen[y * w + x] = 1;
      out[y * w + x] = 255;
      if (y > 0) {
        const ok = !seen[(y - 1) * w + x] && near(x, y - 1);
        if (ok && !up) stack.push(x, y - 1);
        up = ok;
      }
      if (y < h - 1) {
        const ok = !seen[(y + 1) * w + x] && near(x, y + 1);
        if (ok && !down) stack.push(x, y + 1);
        down = ok;
      }
    }
  }
}

const hexRgb = (hex: string): [number, number, number] => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  const n = m ? parseInt(m[1]!, 16) : 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

/** A colour range: every pixel near a colour (0..100 how near), with a soft edge. */
function colorRange(out: Uint8Array, w: number, h: number, px: Pixels, s: { color?: string; x?: number; y?: number; range: number }) {
  const at = sampler(px, w, h);
  const target = s.color ? hexRgb(s.color) : at(clamp(Math.floor((s.x ?? 0.5) * w), 0, w - 1), clamp(Math.floor((s.y ?? 0.5) * h), 0, h - 1));
  const r = Math.max(1, clamp(s.range, 0, 100) * 2.2);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [a, b, c] = at(x, y);
      const d = Math.sqrt((a - target[0]) ** 2 * 0.3 + (b - target[1]) ** 2 * 0.59 + (c - target[2]) ** 2 * 0.11) * 1.7;
      if (d < r) out[y * w + x] = 255;
      else if (d < r * 1.5) out[y * w + x] = Math.round(255 * (1 - (d - r) / (r * 0.5)));
    }
  }
}

/** One shape at this size. Shapes that read the picture (wand, colour) draw nothing without its pixels. */
function shapeMask(shape: Shape, w: number, h: number, px?: Pixels | null, masks?: MaskSource): Uint8Array {
  const out = new Uint8Array(w * h);
  switch (shape.type) {
    case "all": out.fill(255); break;
    case "rect": rect(out, w, h, shape); break;
    case "ellipse": ellipse(out, w, h, shape); break;
    case "polygon": polygon(out, w, h, shape.points); break;
    case "stroke": stroke(out, w, h, shape.points, shape.size, shape.hardness ?? 1); break;
    case "wand": if (px) wand(out, w, h, px, shape); break;
    case "color": if (px) colorRange(out, w, h, px, shape); break;
    case "object": {
      const m = shape.mask ? masks?.(shape.mask, w, h) : null;
      if (m && m.length === w * h) out.set(m);
      break;
    }
  }
  return out;
}

/** A box blur of `r` pixels along rows then columns, in place: three of them are close to a gaussian. */
function boxBlur(m: Uint8Array, w: number, h: number, r: number) {
  if (r < 1) return;
  const tmp = new Float32Array(Math.max(w, h));
  const line = (get: (i: number) => number, set: (i: number, v: number) => void, n: number) => {
    let acc = 0;
    const span = r * 2 + 1;
    for (let i = -r; i <= r; i++) acc += get(clamp(i, 0, n - 1));
    for (let i = 0; i < n; i++) {
      tmp[i] = acc / span;
      acc += get(clamp(i + r + 1, 0, n - 1)) - get(clamp(i - r, 0, n - 1));
    }
    for (let i = 0; i < n; i++) set(i, tmp[i]!);
  };
  for (let y = 0; y < h; y++) line((i) => m[y * w + i]!, (i, v) => { m[y * w + i] = Math.round(v); }, w);
  for (let x = 0; x < w; x++) line((i) => m[i * w + x]!, (i, v) => { m[i * w + x] = Math.round(v); }, h);
}

/** Feather by `px` pixels: three box blurs, the edge going soft over about that distance. */
function feather(m: Uint8Array, w: number, h: number, px: number) {
  const r = Math.round(px / 3);
  for (let k = 0; k < 3; k++) boxBlur(m, w, h, r);
}

/** Grow (positive) or shrink (negative) by `px` pixels: a square neighbourhood's max, or its min. */
function grow(m: Uint8Array, w: number, h: number, px: number) {
  const r = Math.round(Math.abs(px));
  if (!r) return;
  const out = new Uint8Array(m.length);
  const pass = (src: Uint8Array, dst: Uint8Array, horiz: boolean) => {
    const n = horiz ? w : h;
    const lines = horiz ? h : w;
    for (let l = 0; l < lines; l++) {
      for (let i = 0; i < n; i++) {
        let v = px > 0 ? 0 : 255;
        for (let k = Math.max(0, i - r); k <= Math.min(n - 1, i + r); k++) {
          const s = src[horiz ? l * w + k : k * w + l]!;
          v = px > 0 ? Math.max(v, s) : Math.min(v, s);
          if (px > 0 ? v === 255 : v === 0) break;
        }
        dst[horiz ? l * w + i : i * w + l] = v;
      }
    }
  };
  pass(m, out, true);
  pass(out, m, false);
}

/**
 * A whole selection at this size: its shapes combined in order (add is the most of both, subtract takes away, intersect
 * keeps what both have), then grown or shrunk, inverted, and feathered. `scale` is this size over the photo's own, so a
 * feather of 20 pixels is 20 of the photo's pixels at any size.
 */
export function rasterize(sel: Selection, w: number, h: number, px?: Pixels | null, masks?: MaskSource, scale = 1): Uint8Array {
  let out: Uint8Array = new Uint8Array(w * h);
  sel.ops.forEach((op, i) => {
    const m = shapeMask(op.shape, w, h, px, masks);
    if (i === 0 && op.op !== "subtract") { out = m; return; }
    for (let k = 0; k < out.length; k++) {
      if (op.op === "add") out[k] = Math.max(out[k]!, m[k]!);
      else if (op.op === "subtract") out[k] = Math.min(out[k]!, 255 - m[k]!);
      else out[k] = Math.min(out[k]!, m[k]!);
    }
  });
  if (sel.grow) grow(out, w, h, sel.grow * scale);
  if (sel.invert) for (let k = 0; k < out.length; k++) out[k] = 255 - out[k]!;
  if (sel.feather) feather(out, w, h, sel.feather * scale);
  return out;
}

/** How much of the picture a mask holds, 0..1. */
export function coverage(m: Uint8Array): number {
  let s = 0;
  for (let k = 0; k < m.length; k++) s += m[k]!;
  return m.length ? s / (m.length * 255) : 0;
}

/** The box around what a mask holds (above half), as 0..1 of the picture; null when it holds nothing. */
export function maskBounds(m: Uint8Array, w: number, h: number): { x: number; y: number; w: number; h: number } | null {
  let x0 = w; let y0 = h; let x1 = -1; let y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (m[y * w + x]! < 128) continue;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : { x: x0 / w, y: y0 / h, w: (x1 + 1 - x0) / w, h: (y1 + 1 - y0) / h };
}

/** The edge of a mask: pixels inside it with a neighbour outside, which the window draws as marching ants. */
export function maskEdge(m: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && m[y * w + x]! >= 128;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!inside(x, y)) continue;
      if (!inside(x - 1, y) || !inside(x + 1, y) || !inside(x, y - 1) || !inside(x, y + 1)) out[y * w + x] = 1;
    }
  }
  return out;
}

/**
 * Remove: what is under a mask filled in from what is around it, by push-pull (the known pixels averaged down a pyramid
 * until the hole is gone, then pulled back up, finer levels winning wherever they know). Smooth, not a clone: right for
 * a blemish, a wire, a speck, a small thing against a plain background. In place.
 */
export function heal(px: Pixels, mask: Uint8Array) {
  const { w, h } = px;
  type Level = { w: number; h: number; c: Float32Array; a: Float32Array };
  const base: Level = { w, h, c: new Float32Array(w * h * 3), a: new Float32Array(w * h) };
  for (let i = 0; i < w * h; i++) {
    const k = mask[i]! >= 128 ? 0 : 1;
    base.a[i] = k;
    base.c[i * 3] = px.data[i * 4]! * k; base.c[i * 3 + 1] = px.data[i * 4 + 1]! * k; base.c[i * 3 + 2] = px.data[i * 4 + 2]! * k;
  }
  const levels: Level[] = [base];
  while (levels.at(-1)!.w > 1 || levels.at(-1)!.h > 1) {
    const f = levels.at(-1)!;
    const nw = Math.max(1, Math.ceil(f.w / 2));
    const nh = Math.max(1, Math.ceil(f.h / 2));
    const n: Level = { w: nw, h: nh, c: new Float32Array(nw * nh * 3), a: new Float32Array(nw * nh) };
    for (let y = 0; y < f.h; y++) {
      for (let x = 0; x < f.w; x++) {
        const i = y * f.w + x;
        const j = (y >> 1) * nw + (x >> 1);
        n.a[j] += f.a[i]!;
        n.c[j * 3] += f.c[i * 3]!; n.c[j * 3 + 1] += f.c[i * 3 + 1]!; n.c[j * 3 + 2] += f.c[i * 3 + 2]!;
      }
    }
    // Kept as weighted sums normalised to at most one, so a coarse level is an average of what it knows.
    for (let j = 0; j < nw * nh; j++) {
      const a = n.a[j]!;
      if (a > 1) { n.c[j * 3] /= a; n.c[j * 3 + 1] /= a; n.c[j * 3 + 2] /= a; n.a[j] = 1; }
    }
    levels.push(n);
  }
  for (let l = levels.length - 2; l >= 0; l--) {
    const f = levels[l]!;
    const c = levels[l + 1]!;
    for (let y = 0; y < f.h; y++) {
      for (let x = 0; x < f.w; x++) {
        const i = y * f.w + x;
        const a = f.a[i]!;
        if (a >= 1) continue;
        const j = Math.min(c.h - 1, y >> 1) * c.w + Math.min(c.w - 1, x >> 1);
        const k = 1 - a;
        f.c[i * 3] += c.c[j * 3]! * k; f.c[i * 3 + 1] += c.c[j * 3 + 1]! * k; f.c[i * 3 + 2] += c.c[j * 3 + 2]! * k;
        f.a[i] = 1;
      }
    }
  }
  // Smooth the filled part once more, so the pyramid's blocks do not show.
  const fill = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) fill[i] = mask[i]! >= 128 ? 255 : 0;
  const soft = fill.slice();
  feather(soft, w, h, 6);
  const tmp = new Float32Array(base.c);
  for (let ch = 0; ch < 3; ch++) {
    const plane = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) plane[i] = clamp(Math.round(tmp[i * 3 + ch]!), 0, 255);
    const blurred = plane.slice();
    for (let k = 0; k < 2; k++) boxBlur(blurred, w, h, 2);
    for (let i = 0; i < w * h; i++) {
      const v = fill[i] ? blurred[i]! : plane[i]!;
      const t = soft[i]! / 255;
      px.data[i * 4 + ch] = Math.round(px.data[i * 4 + ch]! * (1 - t) + v * t);
    }
  }
}
