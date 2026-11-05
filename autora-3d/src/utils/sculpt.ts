/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Freehand sculpting of a mesh shape: brushes that push, pull, smooth and drag its surface. All of it is plain arithmetic on the
// shape's own numbers (`[x, y, height]` triples, mm), so the viewer applies a stroke live and keeps one result for undo.
// Vertices that sit at the same place (a file's seams) move as one, so a stroke never tears a mesh open.

export type BrushKind = 'grab' | 'build' | 'smooth' | 'flatten';
export type Symmetry = 'off' | 'x' | 'y';

export interface Brush {
  kind: BrushKind;
  /** How far the brush reaches, mm. */
  radius: number;
  /** 0..1: how hard it works. */
  strength: number;
  /** Build only: cut in instead of building out. */
  carve: boolean;
  /** Mirror every stroke across the plane through the shape's middle: x = middle (left-right) or y = middle (front-back). */
  symmetry: Symmetry;
}

export const BRUSH_KINDS: { kind: BrushKind; label: string; hint: string }[] = [
  { kind: 'grab', label: 'Grab', hint: 'Drag a part of the surface to pull it along' },
  { kind: 'build', label: 'Build', hint: 'Raise the surface where you paint (Shift or Carve cuts in)' },
  { kind: 'smooth', label: 'Smooth', hint: 'Soften lumps and creases' },
  { kind: 'flatten', label: 'Flatten', hint: 'Press the surface toward a flat plane' },
];

export const DEFAULT_BRUSH: Brush = { kind: 'build', radius: 20, strength: 0.5, carve: false, symmetry: 'off' };
export const MIN_RADIUS = 2;

type V3 = [number, number, number];

const falloff = (t: number) => (t >= 1 ? 0 : (1 - t * t) * (1 - t * t));

export class SculptMesh {
  /** Triangles (vertex numbers as the shape has them). */
  readonly indices: number[];
  private readonly count: number;
  /** One entry per place on the surface: the vertices at the same spot share it. */
  private readonly pts: Float64Array;
  private readonly slot: Int32Array;
  private readonly tris: Int32Array;
  private readonly near: number[][];
  private readonly normal: Float64Array;
  /** The middle of the shape's footprint: where a mirror plane stands. */
  readonly middle: { x: number; y: number };

  private held: { weights: Map<number, number>; origin: Map<number, V3>; mirror: boolean } | null = null;
  private grab: { sets: { weights: Map<number, number>; sign: V3 }[]; origin: Float64Array } | null = null;

  constructor(positions: number[], indices: number[]) {
    this.indices = indices;
    this.count = positions.length / 3;
    const unique = new Map<string, number>();
    this.slot = new Int32Array(this.count);
    const pts: number[] = [];
    for (let i = 0; i < this.count; i++) {
      const key = `${Math.round(positions[i * 3] * 1000)},${Math.round(positions[i * 3 + 1] * 1000)},${Math.round(positions[i * 3 + 2] * 1000)}`;
      let s = unique.get(key);
      if (s === undefined) {
        s = pts.length / 3;
        unique.set(key, s);
        pts.push(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
      }
      this.slot[i] = s;
    }
    this.pts = Float64Array.from(pts);
    this.tris = Int32Array.from(indices, (v) => this.slot[v]);
    const n = pts.length / 3;
    const near: Set<number>[] = Array.from({ length: n }, () => new Set<number>());
    for (let t = 0; t < this.tris.length; t += 3) {
      for (let e = 0; e < 3; e++) {
        const a = this.tris[t + e];
        const b = this.tris[t + ((e + 1) % 3)];
        if (a !== b) {
          near[a].add(b);
          near[b].add(a);
        }
      }
    }
    this.near = near.map((s) => [...s]);
    this.normal = new Float64Array(n * 3);
    let lx = Infinity, hx = -Infinity, ly = Infinity, hy = -Infinity;
    for (let i = 0; i < n; i++) {
      lx = Math.min(lx, this.pts[i * 3]);
      hx = Math.max(hx, this.pts[i * 3]);
      ly = Math.min(ly, this.pts[i * 3 + 1]);
      hy = Math.max(hy, this.pts[i * 3 + 1]);
    }
    this.middle = { x: (lx + hx) / 2, y: (ly + hy) / 2 };
    this.computeNormals();
  }

  get triangles(): number {
    return this.indices.length / 3;
  }

  /** The surface as the shape keeps it: every vertex, in the order the triangles use. */
  positions(): number[] {
    const out = new Array<number>(this.count * 3);
    for (let i = 0; i < this.count; i++) {
      const s = this.slot[i] * 3;
      out[i * 3] = Math.round(this.pts[s] * 1000) / 1000;
      out[i * 3 + 1] = Math.round(this.pts[s + 1] * 1000) / 1000;
      out[i * 3 + 2] = Math.round(this.pts[s + 2] * 1000) / 1000;
    }
    return out;
  }

  /** The surface in the viewer's layout (x, height + lift, -y), written into `out` (three numbers a vertex). */
  writeWorld(out: Float32Array, lift: number): void {
    for (let i = 0; i < this.count; i++) {
      const s = this.slot[i] * 3;
      out[i * 3] = this.pts[s];
      out[i * 3 + 1] = this.pts[s + 2] + lift;
      out[i * 3 + 2] = -this.pts[s + 1];
    }
  }

  private computeNormals(): void {
    const nrm = this.normal;
    nrm.fill(0);
    const p = this.pts;
    for (let t = 0; t < this.tris.length; t += 3) {
      const a = this.tris[t] * 3, b = this.tris[t + 1] * 3, c = this.tris[t + 2] * 3;
      const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
      const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      for (const i of [a, b, c]) {
        nrm[i] += nx;
        nrm[i + 1] += ny;
        nrm[i + 2] += nz;
      }
    }
    for (let i = 0; i < nrm.length; i += 3) {
      const l = Math.hypot(nrm[i], nrm[i + 1], nrm[i + 2]) || 1;
      nrm[i] /= l;
      nrm[i + 1] /= l;
      nrm[i + 2] /= l;
    }
  }

  private mirrorOf(at: V3, sym: Symmetry): V3 | null {
    if (sym === 'x') return [2 * this.middle.x - at[0], at[1], at[2]];
    if (sym === 'y') return [at[0], 2 * this.middle.y - at[1], at[2]];
    return null;
  }

  private within(at: V3, radius: number): Map<number, number> {
    const out = new Map<number, number>();
    const p = this.pts;
    const r2 = radius * radius;
    for (let i = 0; i < p.length; i += 3) {
      const dx = p[i] - at[0], dy = p[i + 1] - at[1], dz = p[i + 2] - at[2];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < r2) out.set(i / 3, falloff(Math.sqrt(d2) / radius));
    }
    return out;
  }

  /** One touch of Build, Smooth or Flatten at a point of the surface (mm), mirrored if the brush says so. */
  dab(at: V3, brush: Brush): void {
    if (brush.kind === 'grab') return;
    this.computeNormals();
    this.dabOne(at, brush);
    const m = this.mirrorOf(at, brush.symmetry);
    if (m) this.dabOne(m, brush);
  }

  private dabOne(at: V3, brush: Brush): void {
    const set = this.within(at, brush.radius);
    if (!set.size) return;
    const p = this.pts;
    const s = Math.max(0, Math.min(1, brush.strength));
    // The direction of the surface here (the brush's own region, so one stray triangle cannot send a push sideways).
    let nx = 0, ny = 0, nz = 0, cx = 0, cy = 0, cz = 0, total = 0;
    for (const [i, w] of set) {
      nx += this.normal[i * 3] * w;
      ny += this.normal[i * 3 + 1] * w;
      nz += this.normal[i * 3 + 2] * w;
      cx += p[i * 3] * w;
      cy += p[i * 3 + 1] * w;
      cz += p[i * 3 + 2] * w;
      total += w;
    }
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;
    cx /= total; cy /= total; cz /= total;
    const moves: [number, number, number, number][] = [];
    for (const [i, w] of set) {
      const o = i * 3;
      if (brush.kind === 'build') {
        const d = s * brush.radius * 0.1 * w * (brush.carve ? -1 : 1);
        moves.push([o, nx * d, ny * d, nz * d]);
      } else if (brush.kind === 'flatten') {
        const off = (p[o] - cx) * nx + (p[o + 1] - cy) * ny + (p[o + 2] - cz) * nz;
        const d = -off * Math.min(1, s * w * 0.6);
        moves.push([o, nx * d, ny * d, nz * d]);
      } else {
        const ring = this.near[i];
        if (!ring.length) continue;
        let ax = 0, ay = 0, az = 0;
        for (const j of ring) {
          ax += p[j * 3];
          ay += p[j * 3 + 1];
          az += p[j * 3 + 2];
        }
        const k = Math.min(1, s * w * 0.9);
        moves.push([o, (ax / ring.length - p[o]) * k, (ay / ring.length - p[o + 1]) * k, (az / ring.length - p[o + 2]) * k]);
      }
    }
    // Applied together afterwards, so a smoothing step does not depend on the order of the points.
    for (const [o, dx, dy, dz] of moves) {
      p[o] += dx;
      p[o + 1] += dy;
      p[o + 2] += dz;
    }
  }

  /** Grab: picks up the surface around a point; `grabMove` then drags it by an offset from where it was picked up. */
  grabBegin(at: V3, brush: Brush): void {
    const sets: { weights: Map<number, number>; sign: V3 }[] = [{ weights: this.within(at, brush.radius), sign: [1, 1, 1] }];
    const m = this.mirrorOf(at, brush.symmetry);
    if (m) sets.push({ weights: this.within(m, brush.radius), sign: brush.symmetry === 'x' ? [-1, 1, 1] : [1, -1, 1] });
    this.grab = { sets, origin: Float64Array.from(this.pts) };
  }

  grabMove(by: V3, strength = 1): void {
    const g = this.grab;
    if (!g) return;
    const p = this.pts;
    const touched = new Set<number>();
    for (const set of g.sets) for (const i of set.weights.keys()) touched.add(i);
    for (const i of touched) {
      let w1 = g.sets[0].weights.get(i) ?? 0;
      let w2 = g.sets[1]?.weights.get(i) ?? 0;
      if (w1 + w2 > 1) {
        const k = w1 + w2;
        w1 /= k;
        w2 /= k;
      }
      const sign = g.sets[1]?.sign ?? [1, 1, 1];
      for (let a = 0; a < 3; a++) p[i * 3 + a] = g.origin[i * 3 + a] + strength * (w1 * by[a] + w2 * sign[a] * by[a]);
    }
  }

  grabEnd(): void {
    this.grab = null;
    this.held = null;
  }

  /** Where the surface is nearest a point, for placing a brush that is held in the air: the closest vertex. */
  nearest(at: V3): V3 {
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < this.pts.length; i += 3) {
      const d = (this.pts[i] - at[0]) ** 2 + (this.pts[i + 1] - at[1]) ** 2 + (this.pts[i + 2] - at[2]) ** 2;
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return [this.pts[best], this.pts[best + 1], this.pts[best + 2]];
  }
}

/** The numbers a shape keeps for a changed surface: its footprint box and height from the new positions. */
export function boundsOf(positions: number[]): { points: { x: number; y: number }[]; height: number } {
  let lx = Infinity, hx = -Infinity, ly = Infinity, hy = -Infinity, top = 0;
  for (let i = 0; i < positions.length; i += 3) {
    lx = Math.min(lx, positions[i]);
    hx = Math.max(hx, positions[i]);
    ly = Math.min(ly, positions[i + 1]);
    hy = Math.max(hy, positions[i + 1]);
    top = Math.max(top, positions[i + 2]);
  }
  const r = (n: number) => Math.round(n * 100) / 100;
  return { points: [{ x: r(lx), y: r(ly) }, { x: r(hx), y: r(ly) }, { x: r(hx), y: r(hy) }, { x: r(lx), y: r(hy) }], height: Math.max(1, r(top)) };
}
