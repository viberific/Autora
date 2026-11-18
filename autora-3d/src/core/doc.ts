/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Body3D, LibraryItem, Point2D, RepeatLink, Rig, SceneLook, ShapeGroup } from '../types';
import { refreshStale } from '../utils/rig';
import { syncInstances } from '../utils/library';
import { normalizeGroups } from '../utils/groups';
import { syncRepeats } from '../utils/repeat';
import { sharePictures } from '../utils/surface';

/** Everything that is saved: the shapes, how they are grouped, and the live repeats that make some of them. */
export interface Doc {
  bodies: Body3D[];
  groups: ShapeGroup[];
  /** Kept repeats: their copies are derived from the source shape and rebuilt on every change. */
  repeats: RepeatLink[];
  /** Reusable objects kept in this project. Placed copies (groups with `place`) follow them. */
  library: LibraryItem[];
  /** How the scene is lit (absent: the studio light). */
  look?: SceneLook;
  /** The skeleton, when the model has one (absent: no rigging, and everything is as it was before rigs). */
  rig?: Rig;
}

/** Makes ids. Each caller supplies its own so ids stay unique (the app uses time, an agent session a counter). */
export type IdGen = (kind: string) => string;

export const emptyDoc = (): Doc => ({ bodies: [], groups: [], repeats: [], library: [] });

/** Settles a document: live-repeat copies are always rebuilt to match their source and path. */
export const settle = (raw: Doc): Doc => {
  // One copy of each surface picture, however many models (history, the command log) hold it.
  const bodies = sharePictures(raw.bodies);
  const library = raw.library.some((i) => i.bodies.some((b) => b.surface?.image)) ? raw.library.map((i) => { const b = sharePictures(i.bodies); return b === i.bodies ? i : { ...i, bodies: b }; }) : raw.library;
  const d = bodies === raw.bodies && library.every((i, n) => i === raw.library[n]) ? raw : { ...raw, bodies, library };
  const placed = syncInstances(d.bodies, d.groups, d.library);
  const synced = syncRepeats(placed.bodies, d.repeats);
  const grouped = normalizeGroups(synced.bodies, placed.groups);
  const out = grouped.bodies === d.bodies && synced.repeats === d.repeats && grouped.groups === d.groups ? d : { ...d, repeats: synced.repeats, ...grouped };
  // A shape edited after it was bound: its weights are marked stale (never silently reused).
  const rig = refreshStale(out.rig, out.bodies);
  return rig === out.rig ? out : { ...out, rig };
};

/** The saved form of a document: what doc_get, export json and the window's file hold. The rig is there only when there is one. */
export const savedDoc = (doc: Doc) => ({ bodies: doc.bodies, groups: doc.groups, repeats: doc.repeats, library: doc.library, ...(doc.look ? { look: doc.look } : {}), ...(doc.rig ? { rig: doc.rig } : {}) });

/** The scene a new document starts with: one plain block. */
export const starterBodies = (): Body3D[] => {
  const outline: Point2D[] = [
    { x: -60, y: -40 },
    { x: 60, y: -40 },
    { x: 60, y: 40 },
    { x: -60, y: 40 },
  ];
  return [
    {
      id: 'body_block',
      name: 'Block',
      points: outline,
      extrusionHeight: 50,
      color: '#6f7a93',
      materialType: 'matte',
      visible: true,
      createdAt: new Date().toISOString(),
    },
  ];
};

export const starterDoc = (): Doc => ({ bodies: starterBodies(), groups: [], repeats: [], library: [] });

/** Reads a saved document, tolerating older ones (no repeats) and refusing anything that is not one. */
export function parseDoc(raw: unknown): Doc | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Partial<Doc>;
  if (!Array.isArray(d.bodies) || !Array.isArray(d.groups)) return null;
  const look = d.look && typeof d.look === 'object' && typeof d.look.environment === 'string' ? { look: d.look } : {};
  const rig = d.rig && typeof d.rig === 'object' && Array.isArray(d.rig.bones) ? { rig: d.rig } : {};
  return settle({ bodies: d.bodies, groups: d.groups, repeats: Array.isArray(d.repeats) ? d.repeats : [], library: Array.isArray(d.library) ? d.library : [], ...look, ...rig });
}

/** A counter-based id generator that never reuses an id already in `doc`. */
export function counterIds(doc: Doc, start = 1): IdGen {
  const used = new Set([...doc.bodies.map((b) => b.id), ...doc.groups.map((g) => g.id), ...doc.repeats.map((r) => r.linkId), ...doc.library.map((i) => i.id)]);
  let n = start;
  return (kind) => {
    let id = `${kind}_${n++}`;
    while (used.has(id)) id = `${kind}_${n++}`;
    used.add(id);
    return id;
  };
}
