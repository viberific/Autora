/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Smooth, organic surfaces made from a few numbers: soft blends of spheres, capsules and ellipsoids (an animal's body, neck
// and legs), tubes lofted along a path through changing cross-sections, and smoothing for any mesh. They make a RawMesh in
// the model's own space (millimetres, z up), which placeMesh turns into a shape, so everything a mesh shape can do applies.

import type { RawMesh } from './meshImport';

export class OrganicError extends Error {}
const bad = (message: string): never => {
  throw new OrganicError(message);
};

export interface Vec {
  x: number;
  y: number;
  z: number;
}

export type PartKind = 'sphere' | 'capsule' | 'ellipsoid';

export interface BlendPart {
  kind: PartKind;
  /** Centre (sphere, ellipsoid) or one end (capsule). */
  a: Vec;
  /** The other end of a capsule. */
  b?: Vec;
  /** Sphere radius; a capsule's radius at `a`. */
  radius?: number;
  /** A capsule's radius at `b` (it tapers from `radius` to this). */
  radius2?: number;
  /** An ellipsoid's half-sizes along x, y and z. */
  radii?: Vec;
}

export const MAX_PARTS = 64;
export const MAX_DETAIL = 120;

const sub = (p: Vec, q: Vec): Vec => ({ x: p.x - q.x, y: p.y - q.y, z: p.z - q.z });
const dot = (p: Vec, q: Vec) => p.x * q.x + p.y * q.y + p.z * q.z;
const len = (p: Vec) => Math.hypot(p.x, p.y, p.z);
const cross = (p: Vec, q: Vec): Vec => ({ x: p.y * q.z - p.z * q.y, y: p.z * q.x - p.x * q.z, z: p.x * q.y - p.y * q.x });
const unit = (p: Vec): Vec => {
  const l = len(p) || 1;
  return { x: p.x / l, y: p.y / l, z: p.z / l };
};

/** Signed distance to one part (negative inside). Capsule and ellipsoid distances are approximate, which a blend does not mind. */
function distance(part: BlendPart, p: Vec): number {
  if (part.kind === 'sphere') return len(sub(p, part.a)) - (part.radius as number);
  if (part.kind === 'capsule') {
    const b = part.b as Vec;
    const ab = sub(b, part.a);
    const t = Math.max(0, Math.min(1, dot(sub(p, part.a), ab) / (dot(ab, ab) || 1)));
    const r = (part.radius as number) + ((part.radius2 as number) - (part.radius as number)) * t;
    return len({ x: p.x - part.a.x - ab.x * t, y: p.y - part.a.y - ab.y * t, z: p.z - part.a.z - ab.z * t }) - r;
  }
  const r = part.radii as Vec;
  const q = sub(p, part.a);
  const k0 = Math.hypot(q.x / r.x, q.y / r.y, q.z / r.z);
  const k1 = Math.hypot(q.x / (r.x * r.x), q.y / (r.y * r.y), q.z / (r.z * r.z));
  return k1 === 0 ? -Math.min(r.x, r.y, r.z) : (k0 * (k0 - 1)) / k1;
}

/** Polynomial smooth minimum: the union of two shapes with a soft join about `k` wide. */
const smin = (a: number, b: number, k: number): number => {
  if (k <= 0) return Math.min(a, b);
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - (h * h * k) / 4;
};

function reach(part: BlendPart): { lo: Vec; hi: Vec } {
  if (part.kind === 'ellipsoid') {
    const r = part.radii as Vec;
    return { lo: { x: part.a.x - r.x, y: part.a.y - r.y, z: part.a.z - r.z }, hi: { x: part.a.x + r.x, y: part.a.y + r.y, z: part.a.z + r.z } };
  }
  const ends = part.kind === 'capsule' ? [part.a, part.b as Vec] : [part.a];
  const r = Math.max(part.radius as number, part.kind === 'capsule' ? (part.radius2 as number) : 0);
  return {
    lo: { x: Math.min(...ends.map((e) => e.x)) - r, y: Math.min(...ends.map((e) => e.y)) - r, z: Math.min(...ends.map((e) => e.z)) - r },
    hi: { x: Math.max(...ends.map((e) => e.x)) + r, y: Math.max(...ends.map((e) => e.y)) + r, z: Math.max(...ends.map((e) => e.z)) + r },
  };
}

/** The parts reflected across the plane where `axis` equals `at`, added to the originals. */
export function mirrored(parts: BlendPart[], axis: 'x' | 'y' | 'z', at: number): BlendPart[] {
  const flip = (v: Vec): Vec => ({ ...v, [axis]: 2 * at - v[axis] });
  return [...parts, ...parts.map((p) => ({ ...p, a: flip(p.a), ...(p.b ? { b: flip(p.b) } : {}) }))];
}

/**
 * The soft union of the parts as a triangle mesh (surface nets on a grid of `detail` cells along the longest side). `smooth` is
 * how wide the soft joins are, in mm: 0 leaves creases where parts meet.
 */
export function blendMesh(parts: BlendPart[], opts: { smooth: number; detail: number }): RawMesh {
  if (!parts.length) bad('Give at least one part.');
  if (parts.length > MAX_PARTS) bad(`At most ${MAX_PARTS} parts (mirroring doubles them).`);
  const boxes = parts.map(reach);
  const pad = Math.max(opts.smooth, 0) + 1;
  const lo = { x: Math.min(...boxes.map((b) => b.lo.x)) - pad, y: Math.min(...boxes.map((b) => b.lo.y)) - pad, z: Math.min(...boxes.map((b) => b.lo.z)) - pad };
  const hi = { x: Math.max(...boxes.map((b) => b.hi.x)) + pad, y: Math.max(...boxes.map((b) => b.hi.y)) + pad, z: Math.max(...boxes.map((b) => b.hi.z)) + pad };
  const longest = Math.max(hi.x - lo.x, hi.y - lo.y, hi.z - lo.z);
  if (!(longest > 0) || !Number.isFinite(longest)) bad('The parts have no size.');
  const cell = longest / Math.max(8, Math.min(MAX_DETAIL, Math.round(opts.detail)));
  const nx = Math.ceil((hi.x - lo.x) / cell) + 1;
  const ny = Math.ceil((hi.y - lo.y) / cell) + 1;
  const nz = Math.ceil((hi.z - lo.z) / cell) + 1;

  const field = new Float32Array(nx * ny * nz);
  const at = (i: number, j: number, k: number) => (k * ny + j) * nx + i;
  const point: Vec = { x: 0, y: 0, z: 0 };
  for (let k = 0; k < nz; k++) {
    point.z = lo.z + k * cell;
    for (let j = 0; j < ny; j++) {
      point.y = lo.y + j * cell;
      for (let i = 0; i < nx; i++) {
        point.x = lo.x + i * cell;
        let d = Infinity;
        for (const part of parts) d = smin(d, distance(part, point), opts.smooth);
        field[at(i, j, k)] = d;
      }
    }
  }
  return surfaceNets(field, nx, ny, nz, lo, cell);
}

/** Naive surface nets: one vertex in each grid cell the surface passes through, a quad across each edge that crosses it. */
function surfaceNets(field: Float32Array, nx: number, ny: number, nz: number, lo: Vec, cell: number): RawMesh {
  const at = (i: number, j: number, k: number) => (k * ny + j) * nx + i;
  const cellVertex = new Int32Array((nx - 1) * (ny - 1) * (nz - 1)).fill(-1);
  const cid = (i: number, j: number, k: number) => (k * (ny - 1) + j) * (nx - 1) + i;
  const positions: number[] = [];
  const corners: [number, number, number][] = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
  const edges: [number, number][] = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  for (let k = 0; k < nz - 1; k++) {
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const v = corners.map(([a, b, c]) => field[at(i + a, j + b, k + c)]);
        const inside = v.filter((d) => d < 0).length;
        if (inside === 0 || inside === 8) continue;
        let sx = 0;
        let sy = 0;
        let sz = 0;
        let n = 0;
        for (const [p, q] of edges) {
          if (v[p] < 0 === v[q] < 0) continue;
          const t = v[p] / (v[p] - v[q]);
          sx += corners[p][0] + (corners[q][0] - corners[p][0]) * t;
          sy += corners[p][1] + (corners[q][1] - corners[p][1]) * t;
          sz += corners[p][2] + (corners[q][2] - corners[p][2]) * t;
          n++;
        }
        cellVertex[cid(i, j, k)] = positions.length / 3;
        positions.push(lo.x + (i + sx / n) * cell, lo.y + (j + sy / n) * cell, lo.z + (k + sz / n) * cell);
      }
    }
  }
  const indices: number[] = [];
  const quad = (a: number, b: number, c: number, d: number, flip: boolean) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) indices.push(a, c, b, a, d, c);
    else indices.push(a, b, c, a, c, d);
  };
  for (let k = 1; k < nz - 1; k++) {
    for (let j = 1; j < ny - 1; j++) {
      for (let i = 1; i < nx - 1; i++) {
        const here = field[at(i, j, k)] < 0;
        if (here !== field[at(i + 1, j, k)] < 0) quad(cellVertex[cid(i, j - 1, k - 1)], cellVertex[cid(i, j, k - 1)], cellVertex[cid(i, j, k)], cellVertex[cid(i, j - 1, k)], here);
        if (here !== field[at(i, j + 1, k)] < 0) quad(cellVertex[cid(i - 1, j, k - 1)], cellVertex[cid(i - 1, j, k)], cellVertex[cid(i, j, k)], cellVertex[cid(i, j, k - 1)], here);
        if (here !== field[at(i, j, k + 1)] < 0) quad(cellVertex[cid(i - 1, j - 1, k)], cellVertex[cid(i, j - 1, k)], cellVertex[cid(i, j, k)], cellVertex[cid(i - 1, j, k)], here);
      }
    }
  }
  return facingOut({ positions, indices });
}

/** Turns every triangle round if the mesh came out inside-out (negative volume), so the faces look outward. */
function facingOut(mesh: RawMesh): RawMesh {
  const p = mesh.positions;
  let volume = 0;
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const a = mesh.indices[t] * 3;
    const b = mesh.indices[t + 1] * 3;
    const c = mesh.indices[t + 2] * 3;
    volume += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  if (volume >= 0) return mesh;
  const indices = mesh.indices.slice();
  for (let t = 0; t < indices.length; t += 3) [indices[t + 1], indices[t + 2]] = [indices[t + 2], indices[t + 1]];
  return { ...mesh, indices };
}

// ---- Loft ---------------------------------------------------------------------------------------

export interface Section {
  at: Vec;
  /** Half-size across the section in the first direction: up for a path that runs sideways, along x for one that runs up or down. */
  radius: number;
  /** Half-size in the other direction (sideways); the same as radius when absent. */
  radius2?: number;
}

export const MAX_SECTIONS = 48;

const catmull = (p0: number, p1: number, p2: number, p3: number, t: number) =>
  0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);

/**
 * A tube along the path through the section centres, its cross-section an ellipse that changes from one section to the next
 * (a leg, a neck, a tail, a horn). The path is a smooth curve through the centres; the ends are closed with caps.
 */
export function loftMesh(sections: Section[], opts: { sides: number; steps: number }): RawMesh {
  if (sections.length < 2) bad('A loft needs at least two sections.');
  if (sections.length > MAX_SECTIONS) bad(`At most ${MAX_SECTIONS} sections.`);
  const sides = Math.max(6, Math.min(64, Math.round(opts.sides)));
  const steps = Math.max(1, Math.min(12, Math.round(opts.steps)));
  const s = sections.map((x) => ({ ...x, radius2: x.radius2 ?? x.radius }));
  const at = (i: number) => s[Math.max(0, Math.min(s.length - 1, i))];
  // The spline through centres and radii.
  const rings: { c: Vec; r: number; r2: number }[] = [];
  for (let i = 0; i < s.length - 1; i++) {
    for (let step = 0; step < steps; step++) {
      const t = step / steps;
      const f = (get: (q: (typeof s)[number]) => number) => catmull(get(at(i - 1)), get(at(i)), get(at(i + 1)), get(at(i + 2)), t);
      rings.push({ c: { x: f((q) => q.at.x), y: f((q) => q.at.y), z: f((q) => q.at.z) }, r: Math.max(0.01, f((q) => q.radius)), r2: Math.max(0.01, f((q) => q.radius2)) });
    }
  }
  const last = s[s.length - 1];
  rings.push({ c: last.at, r: last.radius, r2: last.radius2 });

  const positions: number[] = [];
  const indices: number[] = [];
  let prevU: Vec | null = null;
  for (let i = 0; i < rings.length; i++) {
    const tangent = unit(sub(rings[Math.min(i + 1, rings.length - 1)].c, rings[Math.max(i - 1, 0)].c));
    if (!(len(tangent) > 0.5)) bad('Two neighbouring sections are in the same place.');
    // Parallel transport: each ring's axes follow the last one so the tube does not twist.
    let u: Vec;
    if (prevU) u = unit(sub(prevU, { x: tangent.x * dot(prevU, tangent), y: tangent.y * dot(prevU, tangent), z: tangent.z * dot(prevU, tangent) }));
    else {
      const ref: Vec = Math.abs(tangent.z) > 0.85 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 0, z: 1 };
      u = unit(sub(ref, { x: tangent.x * dot(ref, tangent), y: tangent.y * dot(ref, tangent), z: tangent.z * dot(ref, tangent) }));
    }
    prevU = u;
    const v = cross(tangent, u);
    for (let a = 0; a < sides; a++) {
      const ang = (a / sides) * Math.PI * 2;
      const cu = Math.cos(ang) * rings[i].r;
      const cv = Math.sin(ang) * rings[i].r2;
      positions.push(rings[i].c.x + u.x * cu + v.x * cv, rings[i].c.y + u.y * cu + v.y * cv, rings[i].c.z + u.z * cu + v.z * cv);
    }
  }
  for (let i = 0; i < rings.length - 1; i++) {
    for (let a = 0; a < sides; a++) {
      const p = i * sides + a;
      const q = i * sides + ((a + 1) % sides);
      indices.push(p, q, p + sides, q, q + sides, p + sides);
    }
  }
  const capAt = (ring: number) => {
    const centre = positions.length / 3;
    positions.push(rings[ring].c.x, rings[ring].c.y, rings[ring].c.z);
    for (let a = 0; a < sides; a++) indices.push(centre, ring * sides + a, ring * sides + ((a + 1) % sides));
  };
  capAt(0);
  capAt(rings.length - 1);
  return facingOut({ positions, indices });
}

// ---- Smoothing ----------------------------------------------------------------------------------

/** Splits every triangle in four at its edge midpoints (the shape stays the same; it only gives smoothing more to work with). */
export function subdivide(mesh: RawMesh): RawMesh {
  const positions = mesh.positions.slice();
  const mid = new Map<number, number>();
  const n = mesh.positions.length / 3;
  const between = (a: number, b: number): number => {
    const key = a < b ? a * n + b : b * n + a;
    let m = mid.get(key);
    if (m === undefined) {
      m = positions.length / 3;
      positions.push((positions[a * 3] + positions[b * 3]) / 2, (positions[a * 3 + 1] + positions[b * 3 + 1]) / 2, (positions[a * 3 + 2] + positions[b * 3 + 2]) / 2);
      mid.set(key, m);
    }
    return m;
  };
  const indices: number[] = [];
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const [a, b, c] = [mesh.indices[t], mesh.indices[t + 1], mesh.indices[t + 2]];
    const ab = between(a, b);
    const bc = between(b, c);
    const ca = between(c, a);
    indices.push(a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca);
  }
  return { ...mesh, positions, indices };
}

/**
 * Evens out the surface without shrinking it (Taubin smoothing: a step toward the neighbours' average, then a smaller step
 * back). Positions are changed in place on a copy; `strength` 0..1 is how far each step goes.
 */
export function smoothMesh(mesh: RawMesh, passes: number, strength: number): RawMesh {
  const n = mesh.positions.length / 3;
  const near: Set<number>[] = Array.from({ length: n }, () => new Set<number>());
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const tri = [mesh.indices[t], mesh.indices[t + 1], mesh.indices[t + 2]];
    for (let e = 0; e < 3; e++) {
      near[tri[e]].add(tri[(e + 1) % 3]);
      near[tri[(e + 1) % 3]].add(tri[e]);
    }
  }
  let cur = Float64Array.from(mesh.positions);
  const step = (k: number) => {
    const next = Float64Array.from(cur);
    for (let i = 0; i < n; i++) {
      const ring = near[i];
      if (!ring.size) continue;
      for (let a = 0; a < 3; a++) {
        let sum = 0;
        for (const j of ring) sum += cur[j * 3 + a];
        next[i * 3 + a] = cur[i * 3 + a] + k * (sum / ring.size - cur[i * 3 + a]);
      }
    }
    cur = next;
  };
  const lambda = Math.max(0, Math.min(1, strength));
  for (let p = 0; p < passes; p++) {
    step(lambda);
    step(-lambda * 1.06);
  }
  return { ...mesh, positions: Array.from(cur) };
}
