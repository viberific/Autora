/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Bone, Rig } from '../types';
import { autoBind, makeRig, modelBox, moveBoneHead, nextBoneId } from '../utils/rig';
import { Doc } from './doc';
import { fail } from './errors';

type V3 = [number, number, number];

// The tools speak the model's axes (x right, y away, z up); the rig is kept in scene space (x right, y up, z toward you).
const toScene = (p: { x: number; y: number; z?: number }): V3 => [p.x, p.z ?? 0, -p.y];
const toModel = (p: V3) => ({ x: p[0], y: -p[2] === 0 ? 0 : -p[2], z: p[1] });

const point = (v: unknown, what: string): V3 => {
  const p = v as { x?: unknown; y?: unknown; z?: unknown } | null;
  if (!p || typeof p !== 'object' || !Number.isFinite(Number(p.x)) || !Number.isFinite(Number(p.y)) || (p.z !== undefined && !Number.isFinite(Number(p.z)))) {
    return fail(`${what} must be a point {x, y, z} in mm (x right, y away, z up).`);
  }
  return toScene({ x: Number(p.x), y: Number(p.y), z: p.z === undefined ? 0 : Number(p.z) });
};

const needRig = (doc: Doc): Rig => doc.rig ?? fail('This model has no skeleton yet.', 'Call rig_add (template "bip29") first.');
const needBone = (rig: Rig, id: unknown): Bone => rig.bones.find((b) => b.id === id) ?? fail(`No bone "${String(id)}".`, `Bones: ${rig.bones.map((b) => `${b.id} (${b.name})`).join(', ')}`);

export function rigGet(doc: Doc) {
  const rig = doc.rig;
  if (!rig) return { rig: null, note: 'No skeleton. rig_add makes one.' };
  return {
    rig: {
      template: rig.template,
      bones: rig.bones.map((b) => ({ id: b.id, name: b.name, parent: b.parentId, head: toModel(b.head), tail: toModel(b.tail) })),
      bound: Object.fromEntries(Object.entries(rig.bind ?? {}).map(([id, b]) => [id, { vertices: b.vertexCount, stale: !!b.stale }])),
      pose: rig.pose ?? {},
    },
  };
}

export function rigAdd(doc: Doc, a: { template?: string; replace?: boolean }) {
  const template = a.template === undefined ? 'bip29' : a.template;
  if (template !== 'bip29' && template !== 'custom') return fail('template must be "bip29" or "custom".');
  if (doc.rig && !a.replace) return fail('This model already has a skeleton.', 'Pass replace: true to start over (its weights are lost).');
  const rig = makeRig(template, modelBox(doc.bodies));
  return { doc: { ...doc, rig }, result: { template, bones: rig.bones.length, note: 'Fitted to the model\'s height and centre. rig_bind ties the shapes to it.' } };
}

export function rigBoneSet(doc: Doc, a: { id?: string; name?: string; head?: unknown; tail?: unknown; parent?: string; move_children?: boolean }) {
  let rig = needRig(doc);
  if (a.id === undefined) {
    // A new bone, hung off `parent` (or a root bone).
    if (a.head === undefined || a.tail === undefined) return fail('A new bone needs head and tail (and optionally parent and name).');
    if (a.parent !== undefined) needBone(rig, a.parent);
    const id = nextBoneId(rig);
    const bone: Bone = { id, name: a.name?.trim() || `Bone ${rig.bones.length + 1}`, parentId: a.parent ?? null, head: point(a.head, 'head'), tail: point(a.tail, 'tail') };
    rig = { ...rig, template: 'custom', bones: [...rig.bones, bone] };
    return { doc: { ...doc, rig }, result: { added: id, note: 'It has no weights yet: rig_bind again.' } };
  }
  const bone = needBone(rig, a.id);
  if (a.name !== undefined) {
    const name = String(a.name).trim();
    if (!name) return fail('name cannot be empty.');
    if (rig.template === 'bip29' && name !== bone.name) rig = { ...rig, template: 'custom' };
    rig = { ...rig, bones: rig.bones.map((b) => (b.id === bone.id ? { ...b, name } : b)) };
  }
  if (a.head !== undefined) rig = moveBoneHead(rig, bone.id, point(a.head, 'head'), a.move_children === true);
  if (a.tail !== undefined) {
    const tail = point(a.tail, 'tail');
    rig = { ...rig, bones: rig.bones.map((b) => (b.id === bone.id ? { ...b, tail } : b)) };
  }
  if (a.head === undefined && a.tail === undefined && a.name === undefined) return fail('Give head, tail or name to change.');
  return { doc: { ...doc, rig }, result: { bone: rig.bones.find((b) => b.id === bone.id)!.id, note: 'Weights are unchanged: rig_bind again to recompute them for the new positions.' } };
}

export function rigBind(doc: Doc) {
  const rig = needRig(doc);
  if (!rig.bones.length) return fail('The skeleton has no bones.');
  const out = autoBind(doc.bodies, rig);
  if (!out.bodies) return fail('Nothing visible to bind.');
  return { doc: { ...doc, rig: out.rig }, result: { bodies: out.bodies, vertices: out.vertices, bones: rig.bones.length } };
}

export function rigPose(doc: Doc, a: { bone?: string; x?: number; y?: number; z?: number; reset?: boolean }) {
  const rig = needRig(doc);
  if (a.reset) {
    if (a.bone === undefined) return { doc: { ...doc, rig: { ...rig, pose: undefined } }, result: { reset: 'all' } };
    needBone(rig, a.bone);
    const { [a.bone]: _gone, ...rest } = rig.pose ?? {};
    return { doc: { ...doc, rig: { ...rig, pose: Object.keys(rest).length ? rest : undefined } }, result: { reset: a.bone } };
  }
  const bone = needBone(rig, a.bone);
  const deg = (v: unknown, k: string) => (v === undefined ? 0 : Number.isFinite(Number(v)) ? Math.max(-360, Math.min(360, Number(v))) : fail(`${k} must be a number of degrees.`));
  const r: V3 = [deg(a.x, 'x'), deg(a.y, 'y'), deg(a.z, 'z')];
  return {
    doc: { ...doc, rig: { ...rig, pose: { ...(rig.pose ?? {}), [bone.id]: r } } },
    result: { bone: bone.id, degrees: { x: r[0], y: r[1], z: r[2] }, note: 'A preview only: exports leave in the rest pose.' },
  };
}
