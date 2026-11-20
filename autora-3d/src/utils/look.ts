/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Sight for a model that cannot see pictures. The model drawn as text from the front, the side and above, each cell shaded
// by how near it is, with the problems a glance at a render would show written out: a part that floats, a form that came
// apart, a model that does not reach the ground, one side unlike the other. No GL, no DOM: the engine runs it headless.

import * as THREE from 'three';
import { Body3D } from '../types';
import { buildBodyGeometry } from './bodyGeometry';
import { frameMatrix } from './frame';

export type ViewName = 'front' | 'back' | 'left' | 'right' | 'top';
export const VIEW_NAMES: ViewName[] = ['front', 'back', 'left', 'right', 'top'];

export interface LookOptions {
  /** The views to draw (default front, right, top). */
  views?: ViewName[];
  /** Columns across the widest view (24 to 100, default 60). */
  width?: number;
  /** Only the part of the model between these heights (mm): a slice, to see the legs from above. */
  from?: number;
  to?: number;
  /** Each cell shows which shape is nearest (a letter) instead of how near it is. */
  byShape?: boolean;
}

interface Tri {
  /** Corners in model space (mm; x right, y away from the front, z up), 9 numbers. */
  p: number[];
  shape: number;
}

/** A shape's triangles in model space, or none when it has no solid. */
function trianglesOf(body: Body3D, shape: number): Tri[] {
  const g = buildBodyGeometry(body, { fast: true });
  if (!g) return [];
  if (body.frame) g.applyMatrix4(frameMatrix(body.frame));
  const pos = g.getAttribute('position');
  const index = g.getIndex();
  const n = index ? index.count : pos.count;
  const out: Tri[] = [];
  for (let t = 0; t + 2 < n; t += 3) {
    const p: number[] = [];
    for (let k = 0; k < 3; k++) {
      const i = index ? index.getX(t + k) : t + k;
      // The geometry is three.js space (y up, z toward the viewer); the model's is z up, y away from the front.
      p.push(pos.getX(i), -pos.getZ(i), pos.getY(i));
    }
    out.push({ p, shape });
  }
  g.dispose();
  return out;
}

/** Where a model point lands in a view: across (u), up the page (v), and how far from the viewer (d). */
function project(view: ViewName, x: number, y: number, z: number): [number, number, number] {
  switch (view) {
    case 'front': return [x, z, y]; // standing at -y, looking toward +y
    case 'back': return [-x, z, -y];
    case 'right': return [y, z, -x]; // standing at +x: the front of the model is on the left
    case 'left': return [-y, z, x];
    case 'top': return [x, y, -z]; // above, the front of the model at the bottom of the page
  }
}

const AXES: Record<ViewName, string> = {
  front: 'seen from the front: x across (left of the page is -x), z up',
  back: 'seen from behind: x across (left of the page is +x), z up',
  right: 'seen from the +x side: y across (the front of the model is on the left), z up',
  left: 'seen from the -x side: y across (the front of the model is on the right), z up',
  top: 'seen from above: x across, y up the page (the front of the model is at the bottom)',
};

/** Near to far. */
const DEPTH = ['@', '#', '+', '-'];
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

interface Grid {
  cols: number;
  rows: number;
  /** Nearest depth per cell, Infinity where empty. */
  depth: Float64Array;
  shape: Int32Array;
  u0: number;
  v0: number;
  du: number;
  dv: number;
  dmin: number;
  dmax: number;
}

/** The triangles drawn into a grid, nearest wins. A triangle smaller than a cell still marks the cell it is in, so a thin leg shows. */
function rasterise(tris: Tri[], view: ViewName, cell: number): Grid {
  const pr = tris.map((t) => [project(view, t.p[0], t.p[1], t.p[2]), project(view, t.p[3], t.p[4], t.p[5]), project(view, t.p[6], t.p[7], t.p[8])]);
  let [u0, u1, v0, v1, dmin, dmax] = [Infinity, -Infinity, Infinity, -Infinity, Infinity, -Infinity];
  for (const c of pr) for (const [u, v, d] of c) {
    u0 = Math.min(u0, u); u1 = Math.max(u1, u);
    v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    dmin = Math.min(dmin, d); dmax = Math.max(dmax, d);
  }
  // A text cell is about twice as tall as it is wide: a row covers twice the millimetres a column does (not from above,
  // where both page directions are lengths on the ground, but the same holds for the cells, so the same rule).
  const du = cell;
  const dv = cell * 2;
  const cols = Math.max(1, Math.ceil((u1 - u0) / du - 1e-9));
  // Centred across, so the middle column is the model's middle and its two halves can be compared cell for cell.
  u0 = (u0 + u1) / 2 - (cols * du) / 2;
  const rows = Math.max(1, Math.ceil((v1 - v0) / dv - 1e-9));
  const depth = new Float64Array(cols * rows).fill(Infinity);
  const shape = new Int32Array(cols * rows).fill(-1);
  const mark = (c: number, r: number, d: number, s: number) => {
    if (c < 0 || r < 0 || c >= cols || r >= rows) return;
    const i = r * cols + c;
    if (d < depth[i]) { depth[i] = d; shape[i] = s; }
  };
  pr.forEach((t, k) => {
    const [a, b, c] = t;
    const s = tris[k].shape;
    const toC = (u: number) => (u - u0) / du;
    const toR = (v: number) => (v - v0) / dv;
    const [ax, ay, bx, by, cx, cy] = [toC(a[0]), toR(a[1]), toC(b[0]), toR(b[1]), toC(c[0]), toR(c[1])];
    const area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
    const cMin = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
    const cMax = Math.min(cols - 1, Math.floor(Math.max(ax, bx, cx)));
    const rMin = Math.max(0, Math.floor(Math.min(ay, by, cy)));
    const rMax = Math.min(rows - 1, Math.floor(Math.max(ay, by, cy)));
    const mid = (a[2] + b[2] + c[2]) / 3;
    // On the far edge of the model a point lands exactly on the grid's end: it belongs to the last cell.
    mark(Math.min(cols - 1, Math.floor((ax + bx + cx) / 3)), Math.min(rows - 1, Math.floor((ay + by + cy) / 3)), mid, s);
    if (Math.abs(area) < 1e-12) return;
    for (let r = rMin; r <= rMax; r++) for (let col = cMin; col <= cMax; col++) {
      const px = col + 0.5;
      const py = r + 0.5;
      const w0 = ((bx - px) * (cy - py) - (cx - px) * (by - py)) / area;
      const w1 = ((cx - px) * (ay - py) - (ax - px) * (cy - py)) / area;
      const w2 = 1 - w0 - w1;
      if (w0 < -1e-9 || w1 < -1e-9 || w2 < -1e-9) continue;
      mark(col, r, w0 * a[2] + w1 * b[2] + w2 * c[2], s);
    }
  });
  return { cols, rows, depth, shape, u0, v0, du, dv, dmin, dmax };
}

const fmt = (n: number) => String(Math.round(n));

function drawGrid(g: Grid, view: ViewName, byShape: boolean): string {
  const span = g.dmax - g.dmin || 1;
  const label = (r: number) => fmt(g.v0 + (r + 0.5) * g.dv);
  const pad = Math.max(...[0, g.rows - 1].map((r) => label(r).length));
  const lines: string[] = [];
  for (let r = g.rows - 1; r >= 0; r--) {
    let line = '';
    for (let c = 0; c < g.cols; c++) {
      const i = r * g.cols + c;
      if (!Number.isFinite(g.depth[i])) line += ' ';
      else if (byShape) line += LETTERS[g.shape[i] % LETTERS.length];
      else line += DEPTH[Math.min(DEPTH.length - 1, Math.floor(((g.depth[i] - g.dmin) / span) * DEPTH.length))];
    }
    // Every fourth row names its height (or its y, from above), so a number can be read off the picture.
    const tag = (g.rows - 1 - r) % 4 === 0 || r === 0 ? label(r).padStart(pad) : ' '.repeat(pad);
    lines.push(`${tag} |${line.replace(/\s+$/, '')}`);
  }
  const across = `${' '.repeat(pad)} +${'-'.repeat(g.cols)}`;
  const ends = `${' '.repeat(pad)}  ${fmt(g.u0)}${' '.repeat(Math.max(1, g.cols - fmt(g.u0).length - fmt(g.u0 + g.cols * g.du).length))}${fmt(g.u0 + g.cols * g.du)}`;
  const up = view === 'top' ? 'y' : 'z';
  return [`${view.toUpperCase()}, ${AXES[view]}. One column ${round1(g.du)} mm, one row ${round1(g.dv)} mm; the numbers down the left are ${up} in mm.`, ...lines, across, ends].join('\n');
}

const round1 = (n: number) => Math.round(n * 10) / 10;

interface Piece {
  shape: number;
  triangles: number;
  min: [number, number, number];
  max: [number, number, number];
}

/** The separate pieces of one shape's surface: triangles joined by shared corners (welded where they meet). */
function piecesOf(tris: Tri[], shape: number): Piece[] {
  const key = (x: number, y: number, z: number) => `${Math.round(x * 100)},${Math.round(y * 100)},${Math.round(z * 100)}`;
  const ids = new Map<string, number>();
  const parent: number[] = [];
  const find = (i: number): number => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };
  const vert = tris.map((t) => [0, 1, 2].map((k) => {
    const s = key(t.p[k * 3], t.p[k * 3 + 1], t.p[k * 3 + 2]);
    let id = ids.get(s);
    if (id === undefined) { id = parent.length; parent.push(id); ids.set(s, id); }
    return id;
  }));
  for (const [a, b, c] of vert) {
    const ra = find(a);
    parent[find(b)] = ra;
    parent[find(c)] = ra;
  }
  const by = new Map<number, Piece>();
  tris.forEach((t, k) => {
    const root = find(vert[k][0]);
    let p = by.get(root);
    if (!p) { p = { shape, triangles: 0, min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }; by.set(root, p); }
    p.triangles++;
    for (let i = 0; i < 3; i++) for (let c = 0; c < 3; c++) {
      p.min[c] = Math.min(p.min[c], t.p[i * 3 + c]);
      p.max[c] = Math.max(p.max[c], t.p[i * 3 + c]);
    }
  });
  return [...by.values()].sort((a, b) => b.triangles - a.triangles);
}

const boxesTouch = (a: Piece, b: Piece, gap: number) => [0, 1, 2].every((c) => a.min[c] <= b.max[c] + gap && b.min[c] <= a.max[c] + gap);
const at = (p: Piece) => `x ${fmt((p.min[0] + p.max[0]) / 2)}, y ${fmt((p.min[1] + p.max[1]) / 2)}, z ${fmt(p.min[2])} to ${fmt(p.max[2])}`;
const sizeOf = (p: Piece) => `${fmt(p.max[0] - p.min[0])} x ${fmt(p.max[1] - p.min[1])} x ${fmt(p.max[2] - p.min[2])} mm`;

/** What a look at a render would catch, in words. */
function findings(bodies: Body3D[], tris: Tri[], cell: number, sliced: boolean): string[] {
  const out: string[] = [];
  const name = (i: number) => `${bodies[i].name} (${bodies[i].id})`;
  const pieces: Piece[] = [];
  /** Pieces already named as islands of their shape: not named again as floating. */
  const told = new Set<Piece>();
  const whole = new Set<number>();
  bodies.forEach((_, i) => {
    const mine = piecesOf(tris.filter((t) => t.shape === i), i);
    if (mine.length === 1) whole.add(i);
    if (mine.length > 1) mine.slice(1).forEach((p) => told.add(p));
    if (mine.length > 1 && !sliced) {
      const loose = mine.slice(1);
      out.push(
        `${name(i)} came out as ${mine.length} separate pieces, not one form: ` +
          loose.slice(0, 4).map((p) => `a ${sizeOf(p)} piece at ${at(p)}`).join('; ') +
          (loose.length > 4 ? `; and ${loose.length - 4} more` : '') +
          '. A part that does not overlap the rest makes its own island: move it in so it overlaps its neighbour by a few mm, make it thicker, or take it out.',
      );
    }
    pieces.push(...mine);
  });
  if (!pieces.length || sliced) return out;
  // Which pieces hold each other up: boxes that touch (generous, so a piece reported as floating really touches nothing).
  const gap = Math.max(0.5, cell * 0.5);
  const lowest = Math.min(...pieces.map((p) => p.min[2]));
  const grounded = pieces.map((p) => p.min[2] <= Math.max(lowest, 0) + gap);
  const held = [...grounded];
  for (let changed = true; changed; ) {
    changed = false;
    pieces.forEach((p, i) => {
      if (held[i]) return;
      if (pieces.some((q, j) => held[j] && boxesTouch(p, q, gap))) { held[i] = true; changed = true; }
    });
  }
  const floating = pieces.filter((_, i) => !held[i]);
  for (const p of floating.filter((f) => !told.has(f)).slice(0, 6)) {
    out.push(whole.has(p.shape) ? `${name(p.shape)} floats: nothing under or beside it touches it (${sizeOf(p)} at ${at(p)}).` : `${name(p.shape)} has a piece that floats: nothing touches it (${sizeOf(p)} at ${at(p)}).`);
  }
  if (lowest > gap) out.push(`The model does not reach the ground: its lowest point is ${fmt(lowest)} mm up.`);
  return out;
}

/** How alike the two halves of a view are, mirrored about its middle, and where they differ most. */
function symmetry(g: Grid): { match: number; worst?: string } {
  let same = 0;
  let filled = 0;
  const rowsOff: number[] = [];
  for (let r = 0; r < g.rows; r++) {
    let off = 0;
    for (let c = 0; c < Math.floor(g.cols / 2); c++) {
      const a = Number.isFinite(g.depth[r * g.cols + c]);
      const b = Number.isFinite(g.depth[r * g.cols + g.cols - 1 - c]);
      if (a || b) filled++;
      if (a && b) same++;
      else if (a || b) off++;
    }
    rowsOff.push(off);
  }
  const match = filled ? same / filled : 1;
  const worst = rowsOff.indexOf(Math.max(...rowsOff));
  return { match, worst: rowsOff[worst] > 1 ? fmt(g.v0 + (worst + 0.5) * g.dv) : undefined };
}

export interface LookResult {
  text: string;
  findings: string[];
  size: { width: number; depth: number; height: number } | null;
}

/** The model drawn as text and checked. `bodies` are the shapes to look at (visible ones). */
export function lookAt(bodies: Body3D[], o: LookOptions = {}): LookResult {
  const views = (o.views?.length ? o.views : (['front', 'right', 'top'] as ViewName[])).filter((v) => VIEW_NAMES.includes(v));
  const width = Math.max(24, Math.min(100, Math.round(o.width ?? 60)));
  let tris = bodies.flatMap((b, i) => trianglesOf(b, i));
  if (!tris.length) return { text: 'Nothing to look at: no visible shape has a solid.', findings: [], size: null };
  const all = tris;
  const sliced = o.from !== undefined || o.to !== undefined;
  if (sliced) {
    const lo = o.from ?? -Infinity;
    const hi = o.to ?? Infinity;
    tris = tris.filter((t) => {
      const z = (t.p[2] + t.p[5] + t.p[8]) / 3;
      return z >= lo && z <= hi;
    });
    if (!tris.length) return { text: `Nothing between z ${fmt(lo)} and ${fmt(hi)} mm.`, findings: [], size: null };
  }
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const t of all) for (let i = 0; i < 9; i++) {
    lo[i % 3] = Math.min(lo[i % 3], t.p[i]);
    hi[i % 3] = Math.max(hi[i % 3], t.p[i]);
  }
  const size = { width: round1(hi[0] - lo[0]), depth: round1(hi[1] - lo[1]), height: round1(hi[2] - lo[2]) };
  // One scale for every view, so the views can be compared with each other: the longest side fills `width` columns.
  const cell = Math.max(size.width, size.depth, size.height, 1) / width;
  const blocks: string[] = [];
  let front: Grid | null = null;
  for (const v of views) {
    const g = rasterise(tris, v, cell);
    if (v === 'front') front = g;
    blocks.push(drawGrid(g, v, !!o.byShape));
  }
  const notes = findings(bodies, all, cell, sliced);
  const sym = symmetry(front ?? rasterise(tris, 'front', cell));
  const legend = o.byShape
    ? `Letters: ${bodies.map((b, i) => `${LETTERS[i % LETTERS.length]} ${b.name} (${b.id})`).join(', ')}.`
    : 'Shading: @ nearest to you, then #, +, - farthest.';
  const head = [
    `The model is ${size.width} mm wide (x), ${size.depth} deep (y), ${size.height} tall (z), from z ${fmt(lo[2])}.${sliced ? ` Only what lies between z ${fmt(o.from ?? lo[2])} and ${fmt(o.to ?? hi[2])} is drawn.` : ''} ${legend}`,
    `Left and right are ${Math.round(sym.match * 100)}% mirror images in the front view${sym.match < 0.92 && sym.worst ? `, differing most at z ${sym.worst}` : ''}.`,
  ];
  return { text: [...head, '', blocks.join('\n\n')].join('\n'), findings: notes, size };
}
