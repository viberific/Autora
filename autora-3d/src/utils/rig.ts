/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import * as THREE from 'three';
import { Body3D, Bone, Rig, RigBind } from '../types';
import { buildBodyGeometry } from './bodyGeometry';
import { frameMatrix } from './frame';

type V3 = [number, number, number];

/** How sharply a bone's pull falls off with distance (mm): weight = 1 / (d + 1) ^ FALLOFF. */
export const FALLOFF = 4;
/** An influence smaller than this share of the total is dropped. */
export const MIN_SHARE = 0.02;

// ------------------------------------------------------------------ template --

/**
 * The bip29 skeleton as [name, parent, head, tail], head and tail as fractions of the figure's height (x to the character's
 * left is +x; the figure faces +z; arms out in a T). The names are Little-Farm's. The first 21 are the spec's tree; the last
 * eight (four fingers on each hand) bring it to 29 and are Autora's own choice, not read from Little-Farm.
 */
/** Two fingers a side, each of two segments, named as Little-Farm's characters name them: Finger0/Finger01, Finger1/Finger11. */
const FINGERS: [number, number][] = [[0, 0.018], [1, 0.006]];
const bip29Table = (): [string, string | null, V3, V3][] => {
  const t: [string, string | null, V3, V3][] = [
    ['bip Pelvis', null, [0, 0.53, 0], [0, 0.57, 0]],
    ['bip Spine', 'bip Pelvis', [0, 0.57, 0], [0, 0.68, 0]],
    ['bip Spine1', 'bip Spine', [0, 0.68, 0], [0, 0.8, 0]],
    ['bip Neck', 'bip Spine1', [0, 0.8, 0], [0, 0.86, 0]],
    ['bip Head', 'bip Neck', [0, 0.86, 0], [0, 1, 0]],
  ];
  for (const [side, s] of [['L', 1], ['R', -1]] as const) {
    const P = `bip ${side} `;
    t.push(
      [`${P}Clavicle`, 'bip Spine1', [0.02 * s, 0.79, 0], [0.1 * s, 0.79, 0]],
      [`${P}UpperArm`, `${P}Clavicle`, [0.1 * s, 0.79, 0], [0.25 * s, 0.79, 0]],
      [`${P}Forearm`, `${P}UpperArm`, [0.25 * s, 0.79, 0], [0.39 * s, 0.79, 0]],
      [`${P}Hand`, `${P}Forearm`, [0.39 * s, 0.79, 0], [0.44 * s, 0.79, 0]],
    );
    for (const [finger, z] of FINGERS) {
      t.push(
        [`${P}Finger${finger}`, `${P}Hand`, [0.44 * s, 0.79, z], [0.47 * s, 0.79, z]],
        [`${P}Finger${finger}1`, `${P}Finger${finger}`, [0.47 * s, 0.79, z], [0.5 * s, 0.79, z]],
      );
    }
    t.push(
      [`${P}Thigh`, 'bip Pelvis', [0.05 * s, 0.53, 0], [0.05 * s, 0.29, 0]],
      [`${P}Calf`, `${P}Thigh`, [0.05 * s, 0.29, 0], [0.05 * s, 0.06, 0]],
      [`${P}Foot`, `${P}Calf`, [0.05 * s, 0.06, 0], [0.05 * s, 0.02, 0.06]],
      [`${P}Toe0`, `${P}Foot`, [0.05 * s, 0.02, 0.06], [0.05 * s, 0.01, 0.11]],
    );
  }
  return t;
};

export const BIP29_COUNT = 29;

/** The scene-space box (mm) of what is visible, or a 1.8 m figure's worth standing at the origin when nothing is. */
export function modelBox(bodies: Body3D[]): THREE.Box3 {
  const box = new THREE.Box3();
  for (const b of bodies) {
    if (!b.visible) continue;
    const g = buildBodyGeometry(b);
    if (!g) continue;
    if (b.frame) g.applyMatrix4(frameMatrix(b.frame));
    g.computeBoundingBox();
    if (g.boundingBox) box.union(g.boundingBox);
  }
  return box.isEmpty() ? new THREE.Box3(new THREE.Vector3(-450, 0, -150), new THREE.Vector3(450, 1800, 150)) : box;
}

const roundMm = (n: number) => Math.round(n * 100) / 100;

/** The shoulder line of the template, as a fraction of height. */
const SHOULDER = 0.79;

/**
 * How far the model actually reaches left and right of `cx` (mm) around shoulder height, or null when nothing is there. Triangle
 * edges are clipped to a band around the shoulders, so a coarse mesh with no vertex at that height still counts.
 */
export function shoulderReach(bodies: Body3D[], box: THREE.Box3, cx: number): { left: number; right: number } | null {
  const h = Math.max(1, box.max.y - box.min.y);
  const lo = box.min.y + (SHOULDER - 0.05) * h;
  const hi = box.min.y + (SHOULDER + 0.05) * h;
  let minX = Infinity;
  let maxX = -Infinity;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const edge = (p: THREE.Vector3, q: THREE.Vector3) => {
    const y0 = Math.min(p.y, q.y);
    const y1 = Math.max(p.y, q.y);
    if (y1 < lo || y0 > hi) return;
    const at = (y: number) => (q.y === p.y ? p.x : p.x + ((q.x - p.x) * (y - p.y)) / (q.y - p.y));
    for (const y of [Math.max(lo, y0), Math.min(hi, y1)]) {
      const x = q.y === p.y ? p.x : at(y);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
    }
    if (q.y === p.y) { minX = Math.min(minX, q.x); maxX = Math.max(maxX, q.x); }
  };
  for (const body of bodies) {
    if (!body.visible) continue;
    const g = buildBodyGeometry(body);
    if (!g) continue;
    if (body.frame) g.applyMatrix4(frameMatrix(body.frame));
    const pos = g.getAttribute('position');
    const idx = g.getIndex();
    const n = idx ? idx.count : pos.count;
    const vertex = (i: number, out: THREE.Vector3) => out.fromBufferAttribute(pos, idx ? idx.getX(i) : i);
    const c = new THREE.Vector3();
    for (let i = 0; i + 2 < n; i += 3) {
      vertex(i, a); vertex(i + 1, b); vertex(i + 2, c);
      edge(a, b); edge(b, c); edge(c, a);
    }
  }
  return Number.isFinite(minX) ? { left: maxX - cx, right: cx - minX } : null;
}

/** What makeRig did with the arms: the centre it used and the span it gave them, for the caller to show. */
export interface RigFit {
  /** The scene-space centre the skeleton stands on: x and z of the model's box, y its lowest point. */
  centre: V3;
  height: number;
  /** Fingertip to fingertip, mm. */
  armSpan: number;
  /** The model's own width at shoulder height, mm. */
  shoulderWidth: number;
  /** True when that width is far short of a T-pose's (arms down or held in). */
  narrow: boolean;
}

/** Below this share of the height, the width at the shoulders is not a T-pose (which is about as wide as it is tall). */
export const T_POSE_SPAN = 0.75;

/**
 * A skeleton of the given template, fitted to the box: as tall as the model, standing on its lowest point, centred on it. The
 * arms follow how far the model really reaches at shoulder height (`reach`), not a span worked out from the height.
 */
export function makeRig(template: 'bip29' | 'custom', box: THREE.Box3, reach?: { left: number; right: number } | null): { rig: Rig; fit: RigFit } {
  const h = Math.max(1, box.max.y - box.min.y);
  const cx = (box.min.x + box.max.x) / 2;
  const cz = (box.min.z + box.max.z) / 2;
  // The template's arm chain ends 0.5 h out; scale it so the fingertips land on the model's real edge on each side.
  const minReach = 0.05 * h;
  const kL = reach ? Math.max(minReach, reach.left) / (0.5 * h) : 1;
  const kR = reach ? Math.max(minReach, reach.right) / (0.5 * h) : 1;
  const ARM = /^bip [LR] (Clavicle|UpperArm|Forearm|Hand|Finger)/;
  const at = (f: V3, k = 1): V3 => [roundMm(cx + f[0] * h * k), roundMm(box.min.y + f[1] * h), roundMm(cz + f[2] * h)];
  const centre: V3 = [roundMm(cx), roundMm(box.min.y), roundMm(cz)];
  if (template === 'custom') {
    return { rig: { template, bones: [{ id: 'bone-1', name: 'Root', parentId: null, head: at([0, 0.5, 0]), tail: at([0, 0.6, 0]) }] }, fit: { centre, height: h, armSpan: 0, shoulderWidth: reach ? reach.left + reach.right : 0, narrow: false } };
  }
  const rows = bip29Table();
  const idOf = new Map(rows.map((r, i) => [r[0], `bone-${i + 1}`]));
  const bones: Bone[] = rows.map(([name, parent, head, tail], i) => {
    const k = ARM.test(name) ? (name.startsWith('bip L') ? kL : kR) : 1;
    return { id: `bone-${i + 1}`, name, parentId: parent ? idOf.get(parent)! : null, head: at(head, k), tail: at(tail, k) };
  });
  const tips = bones.filter((b) => /Finger\d1$/.test(b.name)).map((b) => b.tail[0]);
  const armSpan = roundMm(Math.max(...tips) - Math.min(...tips));
  const shoulderWidth = reach ? roundMm(reach.left + reach.right) : roundMm(h);
  return { rig: { template, bones }, fit: { centre, height: h, armSpan, shoulderWidth, narrow: shoulderWidth < T_POSE_SPAN * h } };
}

export const nextBoneId = (rig: Rig): string => {
  let n = rig.bones.length + 1;
  const used = new Set(rig.bones.map((b) => b.id));
  while (used.has(`bone-${n}`)) n++;
  return `bone-${n}`;
};

/** Every bone below this one, at any depth. */
export function descendants(rig: Rig, id: string): string[] {
  const out: string[] = [];
  const walk = (p: string) => rig.bones.forEach((b) => b.parentId === p && (out.push(b.id), walk(b.id)));
  walk(id);
  return out;
}

/**
 * Moves a bone's head (and optionally its whole branch with it). A parent whose tail sat on the old head follows it, so the chain
 * stays joined. Returns a new rig.
 */
export function moveBoneHead(rig: Rig, id: string, head: V3, withChildren: boolean): Rig {
  const bone = rig.bones.find((b) => b.id === id);
  if (!bone) return rig;
  const d: V3 = [head[0] - bone.head[0], head[1] - bone.head[1], head[2] - bone.head[2]];
  const move = new Set<string>(withChildren ? [id, ...descendants(rig, id)] : [id]);
  const shift = (p: V3): V3 => [roundMm(p[0] + d[0]), roundMm(p[1] + d[1]), roundMm(p[2] + d[2])];
  const joined = bone.parentId ? rig.bones.find((b) => b.id === bone.parentId) : undefined;
  const joinedTail = joined && joined.tail.every((v, i) => Math.abs(v - bone.head[i]) < 1e-6);
  return {
    ...rig,
    bones: rig.bones.map((b) => {
      if (move.has(b.id)) return { ...b, head: shift(b.head), tail: b.id === id && !withChildren ? b.tail : shift(b.tail) };
      if (joinedTail && b.id === joined!.id) return { ...b, tail: shift(b.tail) };
      return b;
    }),
  };
}

// ---------------------------------------------------------------------- bind --

const distToSegment = (p: V3, a: V3, b: V3): number => {
  const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
  const len2 = abx * abx + aby * aby + abz * abz;
  let t = len2 > 1e-12 ? ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby + (p[2] - a[2]) * abz) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const dx = p[0] - (a[0] + abx * t), dy = p[1] - (a[1] + aby * t), dz = p[2] - (a[2] + abz * t);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
};

type Side = 'L' | 'R' | null;
const sideOf = (name: string): Side => (/^bip L /.test(name) ? 'L' : /^bip R /.test(name) ? 'R' : null);

/** Four bone numbers and weights for each point (scene mm), by the rules in the spec. */
export function bindPoints(points: Float32Array | number[], rig: Rig): { joints: number[]; weights: number[] } {
  const bones = rig.bones;
  const n = points.length / 3;
  const joints = new Array<number>(n * 4).fill(0);
  const weights = new Array<number>(n * 4).fill(0);
  if (!bones.length) return { joints, weights };
  const named = (name: string) => bones.findIndex((b) => b.name === name);
  const neck = named('bip Neck');
  const head = named('bip Head');
  const pelvis = named('bip Pelvis');
  const sides = bones.map((b) => sideOf(b.name));
  const legBone = bones.map((b) => /^bip [LR] (Thigh|Calf|Foot|Toe0)$/.test(b.name));
  const armBone = bones.map((b) => /^bip [LR] (Clavicle|UpperArm|Forearm|Hand|Finger\d+)$/.test(b.name));
  let lo = Infinity, hi = -Infinity;
  bones.forEach((b) => [b.head[1], b.tail[1]].forEach((y) => { lo = Math.min(lo, y); hi = Math.max(hi, y); }));
  // Within this far of the middle a point belongs to both sides.
  const band = Math.max(1, (hi - lo) * 0.03);
  const raw = new Float64Array(bones.length);
  for (let v = 0; v < n; v++) {
    const p: V3 = [points[v * 3], points[v * 3 + 1], points[v * 3 + 2]];
    // The head and what grows on it (hair) is the head bone's alone: nothing above the neck takes arm weights.
    if (head >= 0 && neck >= 0 && p[1] > bones[neck].tail[1]) {
      joints[v * 4] = head;
      weights[v * 4] = 1;
      continue;
    }
    // Above the base of the neck, over the middle of the body: no arm pulls on it (the arms are out to the sides).
    const overNeck = neck >= 0 && p[1] > bones[neck].head[1] && Math.abs(p[0] - bones[neck].head[0]) < (hi - lo) * 0.12;
    const left = Math.max(0, Math.min(1, 0.5 + p[0] / (2 * band)));
    const belowPelvis = pelvis >= 0 && p[1] < bones[pelvis].head[1] && bones.some((_, i) => legBone[i]);
    let sum = 0;
    let nearest = 0;
    let nearestD = Infinity;
    for (let i = 0; i < bones.length; i++) {
      const d = distToSegment(p, bones[i].head, bones[i].tail);
      if (d < nearestD) { nearestD = d; nearest = i; }
      let w = 1 / Math.pow(d + 1, FALLOFF);
      // Below the pelvis the legs take over, by side; elsewhere a sided bone fades out across the middle.
      if (belowPelvis && !legBone[i]) w = 0;
      if (overNeck && armBone[i]) w = 0;
      if (sides[i] === 'L') w *= left;
      else if (sides[i] === 'R') w *= 1 - left;
      raw[i] = w;
      sum += w;
    }
    if (sum <= 0) { joints[v * 4] = nearest; weights[v * 4] = 1; continue; }
    const order = Array.from(raw.keys()).sort((a, b) => raw[b] - raw[a]).slice(0, 4);
    let top = 0;
    order.forEach((i) => (top += raw[i]));
    const kept = order.filter((i) => raw[i] >= top * MIN_SHARE);
    let keptSum = 0;
    kept.forEach((i) => (keptSum += raw[i]));
    // Round to 5 places; the largest takes the remainder so the four still add to exactly 1.
    const w5 = kept.map((i) => Math.round((raw[i] / keptSum) * 1e5) / 1e5);
    w5[0] = Math.round((1 - w5.slice(1).reduce((s, x) => s + x, 0)) * 1e5) / 1e5;
    kept.forEach((i, k) => { joints[v * 4 + k] = i; weights[v * 4 + k] = w5[k]; });
  }
  return { joints, weights };
}

/** The shape's generated triangles in the scene (frames applied), flattened, or null when it has none. */
export function scenePositions(body: Body3D): Float32Array | null {
  const g = buildBodyGeometry(body);
  if (!g) return null;
  if (body.frame) g.applyMatrix4(frameMatrix(body.frame));
  return new Float32Array(g.getAttribute('position').array);
}

const NOT_GEOMETRY = new Set(['name', 'color', 'materialType', 'surface', 'hair', 'createdAt', 'visible', 'groupId', 'instanceOf', 'repeatOf']);
const sigCache = new WeakMap<Body3D, string>();
/** A fingerprint of what shapes a body's triangles (its outline, height, bevels, mesh, place), not its look. */
export function geometrySig(body: Body3D): string {
  let s = sigCache.get(body);
  if (s === undefined) {
    const text = JSON.stringify(body, (k, v) => (NOT_GEOMETRY.has(k) ? undefined : v));
    let a = 0x811c9dc5, b = 5381;
    for (let i = 0; i < text.length; i++) {
      a = Math.imul(a ^ text.charCodeAt(i), 0x01000193);
      b = (Math.imul(b, 33) + text.charCodeAt(i)) | 0;
    }
    s = `${(a >>> 0).toString(16)}${(b >>> 0).toString(16)}:${text.length}`;
    sigCache.set(body, s);
  }
  return s;
}

/** Ties every visible shape to the skeleton. Returns the new rig and the counts. */
export function autoBind(bodies: Body3D[], rig: Rig): { rig: Rig; vertices: number; bodies: number } {
  const bind: Record<string, RigBind> = {};
  let vertices = 0;
  for (const body of bodies) {
    if (!body.visible) continue;
    const pos = scenePositions(body);
    if (!pos) continue;
    const { joints, weights } = bindPoints(pos, rig);
    bind[body.id] = { joints, weights, vertexCount: pos.length / 3, sig: geometrySig(body) };
    vertices += pos.length / 3;
  }
  return { rig: { ...rig, bind }, vertices, bodies: Object.keys(bind).length };
}

/** Marks a bind stale when its shape changed or went away. Returns the same rig when nothing did (so nothing re-renders). */
export function refreshStale(rig: Rig | undefined, bodies: Body3D[]): Rig | undefined {
  if (!rig?.bind) return rig;
  let changed = false;
  const bind: Record<string, RigBind> = {};
  for (const [id, b] of Object.entries(rig.bind)) {
    const body = bodies.find((x) => x.id === id);
    const stale = !body || (b.sig !== undefined && b.sig !== geometrySig(body));
    if (!!b.stale !== stale) { changed = true; bind[id] = { ...b, stale: stale || undefined }; } else bind[id] = b;
  }
  return changed ? { ...rig, bind } : rig;
}

/** The binds that can still be used as they are: not stale, and for as many vertices as the shape now has. */
export const usableBind = (rig: Rig | undefined, id: string, vertexCount: number): RigBind | null => {
  const b = rig?.bind?.[id];
  return b && !b.stale && b.vertexCount === vertexCount ? b : null;
};

// ---------------------------------------------------------------------- pose --

const restWorld = (b: Bone) => new THREE.Matrix4().makeTranslation(b.head[0], b.head[1], b.head[2]);

/** Each bone's skinning matrix for the rig's preview pose (identity at rest): world pose times the inverse of the rest world. */
export function skinMatrices(rig: Rig): THREE.Matrix4[] {
  const byId = new Map(rig.bones.map((b, i) => [b.id, i]));
  const world: (THREE.Matrix4 | undefined)[] = [];
  const worldOf = (i: number): THREE.Matrix4 => {
    const cached = world[i];
    if (cached) return cached;
    const b = rig.bones[i];
    const pi = b.parentId ? byId.get(b.parentId) : undefined;
    const parent = pi === undefined ? undefined : rig.bones[pi];
    const local = new THREE.Matrix4().makeTranslation(b.head[0] - (parent?.head[0] ?? 0), b.head[1] - (parent?.head[1] ?? 0), b.head[2] - (parent?.head[2] ?? 0));
    const r = rig.pose?.[b.id];
    if (r) local.multiply(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(THREE.MathUtils.degToRad(r[0]), THREE.MathUtils.degToRad(r[1]), THREE.MathUtils.degToRad(r[2]), 'XYZ')));
    const w = pi === undefined ? local : worldOf(pi).clone().multiply(local);
    world[i] = w;
    return w;
  };
  return rig.bones.map((b, i) => worldOf(i).clone().multiply(restWorld(b).invert()));
}

/** Where a bound shape's vertices go in the preview pose (positions flattened, scene mm). */
export function posePositions(pos: Float32Array, bind: RigBind, mats: THREE.Matrix4[]): Float32Array {
  const out = new Float32Array(pos.length);
  const v = new THREE.Vector3();
  const acc = new THREE.Vector3();
  for (let i = 0; i < pos.length / 3; i++) {
    acc.set(0, 0, 0);
    for (let k = 0; k < 4; k++) {
      const w = bind.weights[i * 4 + k];
      if (w > 0) acc.addScaledVector(v.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]).applyMatrix4(mats[bind.joints[i * 4 + k]]), w);
    }
    out[i * 3] = acc.x; out[i * 3 + 1] = acc.y; out[i * 3 + 2] = acc.z;
  }
  return out;
}
