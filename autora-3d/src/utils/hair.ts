/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Hair and fur grown from a shape's surface. A shape keeps only the numbers (`Body3D.hair`) and the person's grooming
 * strokes; the strands are grown from them, seeded, whenever the shape is drawn or exported, so the same settings always
 * grow the same hair and the shape underneath stays free to move, resize and sculpt. Needs no DOM: the viewer, the GLB
 * export and the headless engine grow the same hair.
 *
 * Space: a body's geometry as `buildBodyGeometry` makes it (Y up, mm, standing on its elevation). Grooming strokes are
 * kept in the shape's own numbers (`[x, y, height]`, like `MeshData`) and turned into that space here.
 */
import * as THREE from 'three';
import { GroomStroke, Hair } from '../types';

export const DEFAULT_HAIR: Hair = {
  style: 'strands',
  density: 30,
  length: 40,
  thickness: 0.3,
  curl: 0,
  frizz: 0.15,
  clump: 0.45,
  droop: 0.6,
  rootColor: '#2b1a10',
  tipColor: '#6b4428',
  shine: 0.6,
  seed: 1,
};

/** What changes when a coat of fur is asked for rather than a head of hair. */
export const FUR_START: Partial<Hair> = { style: 'fur', density: 40, length: 8, thickness: 0.25, curl: 0, frizz: 0.3, clump: 0.1, droop: 0.15 };

export const HAIR_RANGES = {
  density: [0.2, 80],
  length: [1, 400],
  thickness: [0.05, 3],
  curl: [0, 1],
  frizz: [0, 1],
  clump: [0, 1],
  droop: [0, 1],
  shine: [0, 1],
} as const satisfies Record<string, readonly [number, number]>;
export type HairNumber = keyof typeof HAIR_RANGES;
export const HAIR_NUMBERS = Object.keys(HAIR_RANGES) as HairNumber[];

export const GROOM_TOOLS: { tool: GroomStroke['tool']; label: string; hint: string }[] = [
  { tool: 'comb', label: 'Comb', hint: 'Lay the hair down the way you stroke' },
  { tool: 'cut', label: 'Cut', hint: 'Shorten the hair under the brush' },
  { tool: 'lengthen', label: 'Lengthen', hint: 'Grow the hair under the brush' },
  { tool: 'puff', label: 'Puff', hint: 'Lift the hair off the surface' },
];

/** The most strands grown for one shape; past it they are spread wider and drawn thicker, so the coat still looks full. */
export const MAX_STRANDS = 12000;
/** The most strokes a shape keeps: the oldest go first. */
export const MAX_STROKES = 200;

/** Settles hair numbers into their ranges, filling in what is missing. */
export function settleHair(h: Partial<Hair>): Hair {
  const out = { ...DEFAULT_HAIR, ...h } as Hair;
  for (const k of HAIR_NUMBERS) {
    const [lo, hi] = HAIR_RANGES[k];
    const v = Number(out[k]);
    out[k] = Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : DEFAULT_HAIR[k];
  }
  out.seed = Math.round(Number.isFinite(out.seed) ? out.seed : 1);
  if (out.style !== 'fur') out.style = 'strands';
  return out;
}

const rng = (seed: number) => {
  let a = (seed * 2654435761) >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** A stroke's path in the geometry's space. */
const strokePath = (s: GroomStroke, lift: number): THREE.Vector3[] => {
  const out: THREE.Vector3[] = [];
  for (let i = 0; i + 2 < s.path.length; i += 3) out.push(new THREE.Vector3(s.path[i], s.path[i + 2] + lift, -s.path[i + 1]));
  return out;
};

/** What the grooming strokes do at one place on the surface. */
export interface GroomAt {
  /** Multiplies the hair's length. */
  length: number;
  /** Where the hair is laid (along the surface), mm per mm of hair. */
  comb: THREE.Vector3;
  /** Lifts it off the surface. */
  lift: number;
}

export function groomer(strokes: GroomStroke[] | undefined, lift: number) {
  const paths = (strokes ?? []).map((s) => ({ s, pts: strokePath(s, lift) })).filter((p) => p.pts.length > 0);
  const seg = new THREE.Vector3();
  const rel = new THREE.Vector3();
  return (p: THREE.Vector3, n: THREE.Vector3): GroomAt => {
    const out: GroomAt = { length: 1, comb: new THREE.Vector3(), lift: 0 };
    for (const { s, pts } of paths) {
      // The nearest point of the stroke's path, and which way the brush was going there.
      let best = Infinity;
      const dir = new THREE.Vector3();
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i];
        const b = pts[Math.min(pts.length - 1, i + 1)];
        seg.subVectors(b, a);
        const len2 = seg.lengthSq();
        const t = len2 > 0 ? Math.min(1, Math.max(0, rel.subVectors(p, a).dot(seg) / len2)) : 0;
        const d = rel.copy(a).addScaledVector(seg, t).distanceTo(p);
        if (d < best) {
          best = d;
          if (len2 > 0) dir.copy(seg).normalize();
          else if (i > 0) dir.subVectors(a, pts[i - 1]).normalize();
        }
      }
      if (best >= s.radius) continue;
      const w = Math.pow(1 - best / s.radius, 2) * Math.min(1, Math.max(0, s.strength));
      switch (s.tool) {
        case 'comb': {
          // Along the surface only: a comb lays hair down, it does not push it into the shape.
          const along = dir.clone().addScaledVector(n, -dir.dot(n));
          if (along.lengthSq() > 1e-8) out.comb.addScaledVector(along.normalize(), w * 1.6);
          out.lift -= w * 0.5;
          break;
        }
        case 'cut': out.length *= 1 - 0.85 * w; break;
        case 'lengthen': out.length *= 1 + 1.2 * w; break;
        case 'puff': out.lift += w * 1.5; break;
      }
    }
    out.length = Math.min(4, Math.max(0.03, out.length));
    return out;
  };
}

interface Root {
  p: THREE.Vector3;
  n: THREE.Vector3;
}

/** Roots spread evenly over the surface (each triangle gets its share by area). */
function sampleRoots(geometry: THREE.BufferGeometry, count: number, random: () => number): Root[] {
  const pos = geometry.getAttribute('position');
  const nrm = geometry.getAttribute('normal');
  const idx = geometry.getIndex();
  const tris = idx ? idx.count / 3 : pos.count / 3;
  const at = (i: number) => (idx ? idx.getX(i) : i);
  const cum = new Float64Array(tris);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  let total = 0;
  for (let t = 0; t < tris; t++) {
    a.fromBufferAttribute(pos, at(t * 3));
    b.fromBufferAttribute(pos, at(t * 3 + 1));
    c.fromBufferAttribute(pos, at(t * 3 + 2));
    total += b.sub(a).cross(c.sub(a)).length() / 2;
    cum[t] = total;
  }
  const roots: Root[] = [];
  if (!(total > 0)) return roots;
  const na = new THREE.Vector3();
  const nb = new THREE.Vector3();
  const nc = new THREE.Vector3();
  for (let k = 0; k < count; k++) {
    const pick = random() * total;
    let lo = 0;
    let hi = tris - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] < pick) lo = mid + 1;
      else hi = mid;
    }
    let u = random();
    let v = random();
    if (u + v > 1) { u = 1 - u; v = 1 - v; }
    const w = 1 - u - v;
    a.fromBufferAttribute(pos, at(lo * 3));
    b.fromBufferAttribute(pos, at(lo * 3 + 1));
    c.fromBufferAttribute(pos, at(lo * 3 + 2));
    const p = new THREE.Vector3().addScaledVector(a, w).addScaledVector(b, u).addScaledVector(c, v);
    let n: THREE.Vector3;
    if (nrm) {
      na.fromBufferAttribute(nrm, at(lo * 3));
      nb.fromBufferAttribute(nrm, at(lo * 3 + 1));
      nc.fromBufferAttribute(nrm, at(lo * 3 + 2));
      n = new THREE.Vector3().addScaledVector(na, w).addScaledVector(nb, u).addScaledVector(nc, v);
    } else n = b.clone().sub(a).cross(c.clone().sub(a));
    if (n.lengthSq() < 1e-12) n.set(0, 1, 0);
    roots.push({ p, n: n.normalize() });
  }
  return roots;
}

/** The number of strands a coat has on this much surface, and how much thicker each is drawn past the cap. */
export function strandBudget(areaMm2: number, hair: Hair, most = MAX_STRANDS): { count: number; widen: number } {
  const wanted = Math.max(1, Math.round((areaMm2 / 100) * hair.density));
  const count = Math.max(1, Math.min(MAX_STRANDS, most, wanted));
  return { count, widen: Math.sqrt(wanted / count) };
}

const surfaceArea = (geometry: THREE.BufferGeometry) => {
  const pos = geometry.getAttribute('position');
  const idx = geometry.getIndex();
  const n = idx ? idx.count : pos.count;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  let total = 0;
  for (let i = 0; i + 2 < n; i += 3) {
    a.fromBufferAttribute(pos, idx ? idx.getX(i) : i);
    b.fromBufferAttribute(pos, idx ? idx.getX(i + 1) : i + 1);
    c.fromBufferAttribute(pos, idx ? idx.getX(i + 2) : i + 2);
    total += b.sub(a).cross(c.sub(a)).length() / 2;
  }
  return total;
};

export interface Strands {
  /** Each strand's points, root first. */
  strands: THREE.Vector3[][];
  /** The surface normal at each root. */
  normals: THREE.Vector3[];
  /** How much wider each is drawn than `thickness` (more surface than the cap allows). */
  widen: number;
}

/**
 * Grows the strands: from each root out along the surface's normal, laid by the comb, falling with droop, curling round
 * its own line, wandering with frizz, and gathering into locks with its neighbours (clump).
 */
/** Another shape hair must stay out of, in the same space as the geometry: a box, or (round) the ellipsoid inside it. */
export interface Obstacle {
  box: THREE.Box3;
  round: boolean;
}

/** The obstacles hair from this surface could reach: those within its length of the shape. */
export function obstaclesNear(geometry: THREE.BufferGeometry, hair: Pick<Hair, 'length'>, all: Obstacle[]): Obstacle[] {
  geometry.computeBoundingBox();
  const reach = geometry.boundingBox!.clone().expandByScalar(hair.length * 1.2);
  return all.filter((o) => o.box.intersectsBox(reach) && !o.box.isEmpty());
}

/** Moves a point out of an obstacle it is inside: off a box by its nearest side, off a round one along its radius. */
function pushOut(q: THREE.Vector3, o: Obstacle, margin: number): boolean {
  const b = o.box;
  if (!b.containsPoint(q)) return false;
  if (o.round) {
    const c = b.getCenter(new THREE.Vector3());
    const h = b.getSize(new THREE.Vector3()).multiplyScalar(0.5).max(new THREE.Vector3(0.5, 0.5, 0.5));
    const r = q.clone().sub(c);
    const d = Math.hypot(r.x / h.x, r.y / h.y, r.z / h.z);
    if (d >= 1 || d < 1e-6) return false;
    q.copy(c).addScaledVector(r, (1 + margin / Math.min(h.x, h.y, h.z)) / d);
    return true;
  }
  const out = [q.x - b.min.x, b.max.x - q.x, q.y - b.min.y, b.max.y - q.y, q.z - b.min.z, b.max.z - q.z];
  const k = out.indexOf(Math.min(...out));
  if (k === 0) q.x = b.min.x - margin;
  else if (k === 1) q.x = b.max.x + margin;
  else if (k === 2) q.y = b.min.y - margin;
  else if (k === 3) q.y = b.max.y + margin;
  else if (k === 4) q.z = b.min.z - margin;
  else q.z = b.max.z + margin;
  return true;
}

export function growStrands(geometry: THREE.BufferGeometry, hairIn: Hair, lift = 0, segments?: number, most = MAX_STRANDS, obstacles: Obstacle[] = []): Strands {
  const hair = settleHair(hairIn);
  const random = rng(hair.seed);
  const { count, widen } = strandBudget(surfaceArea(geometry), hair, most);
  const roots = sampleRoots(geometry, count, random);
  const groom = groomer(hair.strokes, lift);
  const steps = segments ?? (hair.style === 'fur' ? 4 : hair.curl > 0.2 ? 14 : 9);
  const down = new THREE.Vector3(0, -1, 0);
  // The shape's body, as the ellipsoid in its box: hair that falls over the shape is kept outside it.
  geometry.computeBoundingBox();
  const box = geometry.boundingBox!;
  const centre = box.getCenter(new THREE.Vector3());
  const half = box.getSize(new THREE.Vector3()).multiplyScalar(0.5).max(new THREE.Vector3(0.5, 0.5, 0.5));
  const rel = new THREE.Vector3();
  const near = obstacles.length ? obstaclesNear(geometry, hair, obstacles) : [];

  const grow = (r: Root, rand: () => number): THREE.Vector3[] => {
    const g = groom(r.p, r.n);
    const length = hair.length * g.length * (0.8 + rand() * 0.4);
    const seg = length / steps;
    const tilt = new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).multiplyScalar(0.25 + hair.frizz * 0.5);
    const start = r.n.clone().multiplyScalar(1 + Math.max(-0.8, g.lift)).add(g.comb).add(tilt).normalize();
    // A frame round the hair's first direction, for its curl.
    const side = Math.abs(start.y) < 0.9 ? new THREE.Vector3(0, 1, 0).cross(start).normalize() : new THREE.Vector3(1, 0, 0).cross(start).normalize();
    const up = start.clone().cross(side).normalize();
    const turns = 1 + hair.curl * 5;
    const radius = hair.curl * length * 0.07;
    const phase = rand() * Math.PI * 2;
    const fall = hair.droop * Math.max(0, 1 - Math.max(0, g.lift) * 0.6);
    // Where it falls to: down and away from the middle of the shape (hair from the crown falls outward, not back into the head).
    const away = new THREE.Vector3(r.p.x - centre.x, 0, r.p.z - centre.z);
    if (away.lengthSq() < 1e-6) away.set(Math.cos(rand() * 6.283), 0, Math.sin(rand() * 6.283));
    const fallTo = away.normalize().multiplyScalar(0.45).add(down).normalize();
    const pts: THREE.Vector3[] = [r.p.clone()];
    const spine = r.p.clone();
    const wander = new THREE.Vector3();
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const bend = Math.min(1, fall * 1.8 * Math.pow(t, 0.7));
      const dir = start.clone().lerp(fallTo, bend).addScaledVector(g.comb, t * 0.8).normalize();
      spine.addScaledVector(dir, seg);
      wander.add(new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).multiplyScalar(hair.frizz * seg * 0.5));
      const a = phase + t * turns * Math.PI * 2;
      const ramp = Math.min(1, t * 3);
      const q = spine.clone().add(wander).addScaledVector(side, Math.cos(a) * radius * ramp).addScaledVector(up, Math.sin(a) * radius * ramp);
      // Keep the hair outside the surface it grows from, and outside the body it falls over.
      const outward = q.clone().sub(r.p).dot(r.n);
      if (outward < 0) q.addScaledVector(r.n, -outward + 0.05);
      // Other shapes it falls onto or into: it rests on them instead (a shoulder, a table, a collar).
      for (const o of near) if (pushOut(q, o, 0.3)) spine.copy(q).sub(wander);
      rel.subVectors(q, centre);
      const inside = Math.hypot(rel.x / half.x, rel.y / half.y, rel.z / half.z);
      if (inside < 1.03 && inside > 1e-6) {
        q.copy(centre).addScaledVector(rel, 1.03 / inside);
        spine.copy(q).sub(wander);
      }
      pts.push(q);
    }
    return pts;
  };

  const own = roots.map((r) => grow(r, random));
  if (hair.clump > 0.01 && roots.length > 8) {
    // Locks: every strand drifts toward a nearby guide strand along its length, meeting it toward the tips.
    const guides: number[] = [];
    const every = Math.max(6, Math.round(14 - hair.clump * 8));
    for (let i = 0; i < roots.length; i += every) guides.push(i);
    const cell = Math.max(1, hair.length * 0.6);
    const grid = new Map<string, number[]>();
    const keyOf = (p: THREE.Vector3) => `${Math.floor(p.x / cell)},${Math.floor(p.y / cell)},${Math.floor(p.z / cell)}`;
    guides.forEach((gi) => {
      const k = keyOf(roots[gi].p);
      const list = grid.get(k);
      if (list) list.push(gi);
      else grid.set(k, [gi]);
    });
    const nearest = (p: THREE.Vector3): number => {
      const cx = Math.floor(p.x / cell);
      const cy = Math.floor(p.y / cell);
      const cz = Math.floor(p.z / cell);
      let best = -1;
      let bd = Infinity;
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        for (const gi of grid.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? []) {
          const d = roots[gi].p.distanceToSquared(p);
          if (d < bd) { bd = d; best = gi; }
        }
      }
      return best;
    };
    const guided = own.map((pts, i) => {
      const gi = nearest(roots[i].p);
      if (gi < 0 || gi === i) return pts;
      const guide = own[gi];
      return pts.map((q, s) => {
        const t = s / steps;
        const k = hair.clump * Math.pow(t, 0.8);
        const target = guide[Math.min(s, guide.length - 1)].clone().sub(roots[gi].p).add(roots[i].p).lerp(guide[Math.min(s, guide.length - 1)], t);
        return q.clone().lerp(target, k);
      });
    });
    return { strands: guided, normals: roots.map((r) => r.n), widen };
  }
  return { strands: own, normals: roots.map((r) => r.n), widen };
}

const colorOf = (hex: string) => new THREE.Color(/^#[0-9a-f]{6}$/i.test(hex) ? hex : '#888888');

/**
 * The strands as flat ribbons: a pair of points across each step of every strand, tapering to the tip, with a colour
 * from root to tip, a tangent along the hair (for the highlight that runs across a strand) and UVs (u across, v along).
 * Returns null when nothing grew.
 */
export function hairGeometry(geometry: THREE.BufferGeometry, hairIn: Hair, lift = 0, most = MAX_STRANDS, obstacles: Obstacle[] = []): THREE.BufferGeometry | null {
  const hair = settleHair(hairIn);
  const { strands, normals, widen } = growStrands(geometry, hair, lift, undefined, most, obstacles);
  if (!strands.length) return null;
  const per = strands[0].length;
  const verts = strands.length * per * 2;
  const position = new Float32Array(verts * 3);
  const normal = new Float32Array(verts * 3);
  const tangent = new Float32Array(verts * 4);
  const color = new Float32Array(verts * 3);
  const uv = new Float32Array(verts * 2);
  const index = new Uint32Array(strands.length * (per - 1) * 6);
  const root = colorOf(hair.rootColor);
  const tip = colorOf(hair.tipColor);
  const c = new THREE.Color();
  const t3 = new THREE.Vector3();
  const side = new THREE.Vector3();
  const nrm = new THREE.Vector3();
  let v = 0;
  let k = 0;
  strands.forEach((pts, s) => {
    const n0 = normals[s];
    const first = v;
    for (let i = 0; i < per; i++) {
      const t = i / (per - 1);
      t3.subVectors(pts[Math.min(per - 1, i + 1)], pts[Math.max(0, i - 1)]);
      if (t3.lengthSq() < 1e-12) t3.copy(n0);
      t3.normalize();
      side.crossVectors(t3, n0);
      if (side.lengthSq() < 1e-8) side.crossVectors(t3, Math.abs(t3.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0));
      side.normalize();
      nrm.crossVectors(side, t3).normalize();
      const half = (hair.thickness * widen * (1 - 0.85 * t)) / 2;
      c.copy(root).lerp(tip, Math.pow(t, 0.8));
      for (const sgn of [-1, 1]) {
        const p = pts[i];
        position.set([p.x + side.x * half * sgn, p.y + side.y * half * sgn, p.z + side.z * half * sgn], v * 3);
        normal.set([nrm.x, nrm.y, nrm.z], v * 3);
        tangent.set([t3.x, t3.y, t3.z, 1], v * 4);
        color.set([c.r, c.g, c.b], v * 3);
        uv.set([sgn < 0 ? 0 : 1, t], v * 2);
        v++;
      }
    }
    for (let i = 0; i < per - 1; i++) {
      const a = first + i * 2;
      index.set([a, a + 1, a + 2, a + 1, a + 3, a + 2], k);
      k += 6;
    }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(position, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  g.setAttribute('tangent', new THREE.BufferAttribute(tangent, 4));
  g.setAttribute('color', new THREE.BufferAttribute(color, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(new THREE.BufferAttribute(index, 1));
  g.computeBoundingSphere();
  return g;
}

/** How many layers a fur coat is drawn in. Fewer on a heavy surface, so it stays quick. */
export const furLayers = (triangles: number) => Math.max(4, Math.min(16, Math.floor(FUR_VERTICES / Math.max(1, triangles * 3))));

/** The most vertices all the layers of one coat of fur add up to: a heavy surface gets fewer layers, so it stays quick to draw. */
export const FUR_VERTICES = 360000;
/** The most strands drawn in the whole scene at once, shared between the shapes with hair. Exports have their own cap. */
export const SCENE_STRANDS = 16000;
/** The most strands written for one shape in a file, and for the whole file. */
export const EXPORT_STRANDS = 4000;
export const EXPORT_STRANDS_TOTAL = 16000;

/**
 * Fur as layers (shells): copies of the surface pushed out along its normals, each a little further, laid by the comb and
 * falling with droop, so a dense short coat is drawn without a separate hair for every strand. Layer `h` runs 0 (skin) to 1
 * (tips). The geometry must be non-indexed with normals, as `buildBodyGeometry` makes it.
 */
export function furShell(geometry: THREE.BufferGeometry, hairIn: Hair, h: number, lift = 0, groomCache?: GroomAt[]): { geometry: THREE.BufferGeometry; groom: GroomAt[] } {
  const hair = settleHair(hairIn);
  const pos = geometry.getAttribute('position');
  const nrm = geometry.getAttribute('normal');
  const uvs = geometry.getAttribute('uv');
  const groom = groomer(hair.strokes, lift);
  const p = new THREE.Vector3();
  const n = new THREE.Vector3();
  const cache = groomCache ?? Array.from({ length: pos.count }, (_, i) => groom(p.fromBufferAttribute(pos, i).clone(), n.fromBufferAttribute(nrm, i).clone().normalize()));
  const out = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i);
    n.fromBufferAttribute(nrm, i).normalize();
    const g = cache[i];
    const len = hair.length * g.length * h;
    const up = 1 + Math.max(-0.7, g.lift);
    p.addScaledVector(n, len * up).addScaledVector(g.comb, len * h * 0.7);
    p.y -= hair.droop * len * h * 0.6 * Math.max(0, 1 - Math.max(0, g.lift));
    out.set([p.x, p.y, p.z], i * 3);
  }
  const shell = new THREE.BufferGeometry();
  shell.setAttribute('position', new THREE.BufferAttribute(out, 3));
  shell.setAttribute('normal', nrm.clone());
  if (uvs) shell.setAttribute('uv', uvs.clone());
  return { geometry: shell, groom: cache };
}

/**
 * The strand pattern a fur layer is cut from: one value per strand cell, so each layer keeps the cells whose value is above
 * its height and the strands thin out toward their tips. RGBA, the value in every channel.
 */
export function furPattern(seed: number, size = 128): Uint8Array {
  const random = rng(seed + 17);
  const out = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const v = Math.round(Math.pow(random(), 0.7) * 255);
    out.set([v, v, v, 255], i * 4);
  }
  return out;
}

/** UV repeats of the fur pattern for its density: one cell per strand (UVs are 100 mm a unit, see surface.ts). */
export const furRepeat = (hair: Hair, size = 128) => (100 / (10 / Math.sqrt(Math.max(0.2, hair.density)))) / size;

/** A few words for the agent's summaries. */
export function describeHair(h: Hair): string {
  const s = settleHair(h);
  const curl = s.curl > 0.6 ? 'curly' : s.curl > 0.25 ? 'wavy' : 'straight';
  const strokes = s.strokes?.length ? `, groomed (${s.strokes.length} strokes)` : '';
  return `${s.style === 'fur' ? 'fur' : 'hair'} ${Math.round(s.length)} mm, ${curl}, ${s.density}/cm²${strokes}`;
}

/** The person's grooming brush: what it does, how far it reaches and how hard. */
export interface GroomBrush {
  tool: GroomStroke['tool'];
  radius: number;
  strength: number;
  /** Each stroke is also made on the other side: across the shape's middle left to right (x) or front to back (y). */
  mirror: 'off' | 'x' | 'y';
}
export const DEFAULT_GROOM: GroomBrush = { tool: 'comb', radius: 15, strength: 0.7, mirror: 'off' };

/** A stroke reflected across the middle of a shape (its footprint's box): x mirrors left to right, y front to back. */
export function mirrorStroke(stroke: GroomStroke, axis: 'x' | 'y', box: { minX: number; maxX: number; minY: number; maxY: number }): GroomStroke {
  const c = axis === 'x' ? box.minX + box.maxX : box.minY + box.maxY;
  const k = axis === 'x' ? 0 : 1;
  return { ...stroke, path: stroke.path.map((v, i) => (i % 3 === k ? Math.round((c - v) * 100) / 100 : v)) };
}
