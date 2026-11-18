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

/** A skeleton of the given template, fitted to the box: as tall as the model, standing on its lowest point, centred on it. */
export function makeRig(template: 'bip29' | 'custom', box: THREE.Box3): Rig {
  const h = Math.max(1, box.max.y - box.min.y);
  const cx = (box.min.x + box.max.x) / 2;
  const cz = (box.min.z + box.max.z) / 2;
  const at = (f: V3): V3 => [roundMm(cx + f[0] * h), roundMm(box.min.y + f[1] * h), roundMm(cz + f[2] * h)];
  if (template === 'custom') {
    return { template, bones: [{ id: 'bone-1', name: 'Root', parentId: null, head: at([0, 0.5, 0]), tail: at([0, 0.6, 0]) }] };
  }
  const rows = bip29Table();
  const idOf = new Map(rows.map((r, i) => [r[0], `bone-${i + 1}`]));
  return {
    template,
    bones: rows.map(([name, parent, head, tail], i) => ({ id: `bone-${i + 1}`, name, parentId: parent ? idOf.get(parent)! : null, head: at(head), tail: at(tail) })),
  };
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
