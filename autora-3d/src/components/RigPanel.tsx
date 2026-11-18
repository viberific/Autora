/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The Rig card: a skeleton for the model. One button adds it (fitted to the model), a tree lists its bones (picking one lights it
 * in the view, where its joint can also be dragged), Bind ties the shapes to it, and a bone picked gets a slider for each way it
 * turns. Posing is a preview: exports always leave in the rest pose.
 */
import React from 'react';
import { Bone, Rig } from '../types';
import { Slider } from './SurfacePanels';

const chip = (on: boolean) =>
  `h-8 px-3 rounded-full text-xs font-medium transition-colors ${on ? 'bg-accent-500 text-white' : 'bg-white/6 text-slate-300 hover:bg-white/12'}`;
const quiet = 'h-8 px-3.5 rounded-full text-xs font-medium bg-white/6 text-slate-200 hover:bg-white/12 disabled:opacity-40';
const primary = 'h-9 px-4 rounded-full bg-accent-500 hover:bg-accent-400 text-white text-sm font-medium transition-colors disabled:opacity-40';
const WIDTH = 'w-[min(19rem,calc(100vw-1.5rem))]';

export interface RigPanelProps {
  rig: Rig | undefined;
  /** How many shapes are visible: nothing to bind to without any. */
  shapes: number;
  boneId: string | null;
  onBone: (id: string | null) => void;
  onAdd: () => void;
  onBind: () => void;
  /** Turn the picked bone: which way (0 x, 1 y, 2 z) and how far, degrees. */
  onPose: (id: string, axis: 0 | 1 | 2, degrees: number) => void;
  onResetPose: () => void;
}

/** Bones in tree order, each with how deep it sits. */
const treeOf = (bones: Bone[]): { bone: Bone; depth: number }[] => {
  const out: { bone: Bone; depth: number }[] = [];
  const ids = new Set(bones.map((b) => b.id));
  const walk = (parent: string | null, depth: number) =>
    bones.forEach((b) => {
      if ((b.parentId && ids.has(b.parentId) ? b.parentId : null) === parent) {
        out.push({ bone: b, depth });
        walk(b.id, depth + 1);
      }
    });
  walk(null, 0);
  return out;
};

export default function RigPanel({ rig, shapes, boneId, onBone, onAdd, onBind, onPose, onResetPose }: RigPanelProps) {
  if (!rig) {
    return (
      <div className={`p-4 flex flex-col gap-3 ${WIDTH}`}>
        <button type="button" className={primary} disabled={shapes < 1} onClick={onAdd}>Add skeleton</button>
        {shapes < 1 && <p className="text-xs text-slate-400">Make a shape first.</p>}
      </div>
    );
  }
  const bind = Object.values(rig.bind ?? {});
  const bound = bind.filter((b) => !b.stale);
  const stale = bind.length - bound.length;
  const vertices = bound.reduce((n, b) => n + b.vertexCount, 0);
  const picked = rig.bones.find((b) => b.id === boneId) ?? null;
  const pose = (picked && rig.pose?.[picked.id]) || [0, 0, 0];
  const posed = !!rig.pose && Object.keys(rig.pose).length > 0;
  return (
    <div className={`p-4 flex flex-col gap-3 ${WIDTH}`}>
      <div className="flex flex-col gap-0.5 max-h-48 overflow-y-auto pr-1" role="tree" aria-label="Bones">
        {treeOf(rig.bones).map(({ bone, depth }) => (
          <button
            key={bone.id}
            type="button"
            role="treeitem"
            aria-selected={bone.id === boneId}
            onClick={() => onBone(bone.id === boneId ? null : bone.id)}
            style={{ paddingLeft: `${0.5 + Math.min(depth, 8) * 0.6}rem` }}
            className={`h-7 pr-2 rounded-full text-left text-xs truncate transition-colors ${bone.id === boneId ? 'bg-accent-500 text-white' : 'text-slate-300 hover:bg-white/10'}`}
          >
            {bone.name.replace(/^bip /, '')}
          </button>
        ))}
      </div>
      <div className="flex flex-col gap-1.5 pt-2 border-t border-white/8">
        <div className="flex items-center gap-2">
          <button type="button" className={chip(bound.length > 0 && stale === 0)} disabled={shapes < 1} onClick={onBind}>{bind.length ? 'Bind again' : 'Bind'}</button>
          <span className="text-xs text-slate-400">
            {bound.length ? `${vertices.toLocaleString()} vertices, ${bound.length} ${bound.length === 1 ? 'body' : 'bodies'} bound` : 'Not bound yet'}
          </span>
        </div>
        {stale > 0 && <p className="text-xs text-amber-300">{stale === 1 ? '1 shape has' : `${stale} shapes have`} changed since it was bound: bind again.</p>}
      </div>
      {picked && (
        <div className="flex flex-col gap-2 pt-2 border-t border-white/8">
          <p className="text-xs text-slate-400">Turn {picked.name.replace(/^bip /, '')}</p>
          {(['X', 'Y', 'Z'] as const).map((axis, i) => (
            <Slider key={axis} label={`Turn ${axis}`} value={pose[i]} min={-180} max={180} step={1} unit="°" onChange={(n) => onPose(picked.id, i as 0 | 1 | 2, n)} />
          ))}
        </div>
      )}
      {posed && <button type="button" className={`${quiet} self-start`} onClick={onResetPose}>Reset pose</button>}
    </div>
  );
}
