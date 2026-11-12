/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import * as THREE from 'three';
import { imageDataUrl, MAX_IMAGE_BYTES } from './surface';
import { Body3D, MeshData, Point2D } from '../types';

// Reads a triangle mesh from a file (GLB/glTF, OBJ or STL) and turns it into a shape. No DOM, so the headless engine and the
// page share it. Textures, skins and animation are not read: a mesh arrives as one solid with the shape's own colour and material.

export type MeshFormat = 'glb' | 'obj' | 'stl';

/** A mesh as the file had it: x, y, z triples in the file's own axes and units, and triangles as vertex numbers. */
export interface RawMesh {
  positions: number[];
  indices: number[];
  /** A colour the file gave (glTF base colour), as #rrggbb. */
  color?: string;
  /** Where each vertex sits on the file's picture (u, v pairs), when every part of it had a layout. */
  uvs?: number[];
  /** The file's base colour picture, as a data URL (glTF `baseColorTexture`, PNG or JPEG inside the file). */
  image?: string;
}

/** Most triangles a shape keeps. A mesh with more is simplified (vertex clustering), which keeps its silhouette. */
export const MAX_TRIANGLES = 60000;

export class MeshError extends Error {}

const bad = (message: string): never => {
  throw new MeshError(message);
};

/** Which format a file is, from its name first and its first bytes if the name does not say. */
export function meshFormatOf(name: string, data?: Uint8Array): MeshFormat | null {
  const ext = /\.(glb|gltf|obj|stl)$/i.exec(name)?.[1]?.toLowerCase();
  if (ext === 'glb' || ext === 'gltf') return 'glb';
  if (ext === 'obj' || ext === 'stl') return ext;
  if (!data || data.length < 12) return null;
  if (data[0] === 0x67 && data[1] === 0x6c && data[2] === 0x54 && data[3] === 0x46) return 'glb';
  const head = new TextDecoder().decode(data.subarray(0, Math.min(data.length, 256)));
  if (/^\s*\{/.test(head) && /"asset"/.test(head)) return 'glb';
  if (/^\s*solid\b/.test(head) && /facet|vertex/.test(head)) return 'stl';
  if (/^\s*(#|v\s|o\s|g\s|mtllib)/m.test(head)) return 'obj';
  return null;
}

/** Reads a file's triangles. Throws a MeshError saying what is wrong with the file. */
export function readMesh(data: Uint8Array, format: MeshFormat): RawMesh {
  const read = format === 'glb' ? readGltf(data) : format === 'obj' ? readObj(data) : readStl(data);
  // Files split a vertex wherever a seam or a normal differs; the solid wants one vertex per place, and no triangle with no area.
  const raw = joinSeams(read);
  if (!raw.indices.length) bad('That file has no triangles in it.');
  return raw;
}

// ---- STL -----------------------------------------------------------------------------------------

function readStl(data: Uint8Array): RawMesh {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const positions: number[] = [];
  if (data.byteLength >= 84) {
    const count = view.getUint32(80, true);
    if (84 + count * 50 === data.byteLength) {
      for (let t = 0; t < count; t++) {
        const at = 84 + t * 50 + 12;
        for (let k = 0; k < 9; k++) positions.push(view.getFloat32(at + k * 4, true));
      }
      return weld(positions);
    }
  }
  const text = new TextDecoder().decode(data);
  const re = /vertex\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)/g;
  for (let m = re.exec(text); m; m = re.exec(text)) positions.push(+m[1], +m[2], +m[3]);
  if (!positions.length || positions.length % 9) bad('That is not an STL file Autora 3D can read (binary or ASCII).');
  return weld(positions);
}

/** Triangles given corner by corner become an indexed mesh, sharing the vertices that sit at the same point. */
function weld(corners: number[]): RawMesh {
  const key = new Map<string, number>();
  const positions: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i < corners.length; i += 3) {
    // Floats from a file: 1e-5 of a unit is far below anything a model shows, and joins a shared corner written twice.
    const k = `${Math.round(corners[i] * 1e5)},${Math.round(corners[i + 1] * 1e5)},${Math.round(corners[i + 2] * 1e5)}`;
    let n = key.get(k);
    if (n === undefined) {
      n = positions.length / 3;
      key.set(k, n);
      positions.push(corners[i], corners[i + 1], corners[i + 2]);
    }
    indices.push(n);
  }
  return { positions, indices: dropFlat(indices) };
}

/** Vertices at the same place become one, triangles that fall flat go, and vertices no triangle uses are dropped. */
function joinSeams(mesh: RawMesh): RawMesh {
  const key = new Map<string, number>();
  const into = new Array<number>(mesh.positions.length / 3);
  const positions: number[] = [];
  const uvs = mesh.uvs && mesh.uvs.length / 2 === into.length ? mesh.uvs : undefined;
  const welded: number[] = [];
  for (let i = 0; i < into.length; i++) {
    const [x, y, z] = [mesh.positions[i * 3], mesh.positions[i * 3 + 1], mesh.positions[i * 3 + 2]];
    // With a picture's layout a seam in it stays a seam: two vertices at one place with different UVs are kept apart.
    const at = uvs ? `,${Math.round(uvs[i * 2] * 1e5)},${Math.round(uvs[i * 2 + 1] * 1e5)}` : '';
    const k = `${Math.round(x * 1e5)},${Math.round(y * 1e5)},${Math.round(z * 1e5)}${at}`;
    let n = key.get(k);
    if (n === undefined) {
      n = positions.length / 3;
      key.set(k, n);
      positions.push(x, y, z);
      if (uvs) welded.push(uvs[i * 2], uvs[i * 2 + 1]);
    }
    into[i] = n;
  }
  const indices = dropFlat(mesh.indices.map((i) => into[i]));
  const used = new Map<number, number>();
  const kept: number[] = [];
  const keptUv: number[] = [];
  const out = indices.map((i) => {
    let n = used.get(i);
    if (n === undefined) {
      n = kept.length / 3;
      used.set(i, n);
      kept.push(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
      if (uvs) keptUv.push(welded[i * 2], welded[i * 2 + 1]);
    }
    return n;
  });
  const { uvs: _drop, ...rest } = mesh;
  return { ...rest, positions: kept, indices: out, ...(uvs ? { uvs: keptUv } : {}) };
}

function dropFlat(indices: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const [a, b, c] = [indices[i], indices[i + 1], indices[i + 2]];
    if (a !== b && b !== c && a !== c) out.push(a, b, c);
  }
  return out;
}

// ---- OBJ -----------------------------------------------------------------------------------------

function readObj(data: Uint8Array): RawMesh {
  const positions: number[] = [];
  const indices: number[] = [];
  const text = new TextDecoder().decode(data);
  for (const line of text.split(/\r?\n/)) {
    if (line.charCodeAt(0) === 118 && line.charCodeAt(1) === 32) {
      const p = line.trim().split(/\s+/);
      const x = +p[1];
      const y = +p[2];
      const z = +p[3];
      if (![x, y, z].every(Number.isFinite)) bad('That OBJ has a vertex that is not a number.');
      positions.push(x, y, z);
    } else if (line.charCodeAt(0) === 102 && line.charCodeAt(1) === 32) {
      const count = positions.length / 3;
      const ring = line
        .trim()
        .split(/\s+/)
        .slice(1)
        .map((token) => {
          const n = parseInt(token.split('/')[0], 10);
          return n < 0 ? count + n : n - 1;
        });
      if (ring.some((n) => !(n >= 0 && n < count))) bad('That OBJ has a face that names a vertex it does not have.');
      for (let k = 1; k + 1 < ring.length; k++) indices.push(ring[0], ring[k], ring[k + 1]);
    }
  }
  return { positions, indices: dropFlat(indices) };
}

// ---- glTF / GLB ----------------------------------------------------------------------------------

const COMPONENT: Record<number, { size: number; read: (v: DataView, at: number) => number; norm: number }> = {
  5120: { size: 1, read: (v, at) => v.getInt8(at), norm: 127 },
  5121: { size: 1, read: (v, at) => v.getUint8(at), norm: 255 },
  5122: { size: 2, read: (v, at) => v.getInt16(at, true), norm: 32767 },
  5123: { size: 2, read: (v, at) => v.getUint16(at, true), norm: 65535 },
  5125: { size: 4, read: (v, at) => v.getUint32(at, true), norm: 1 },
  5126: { size: 4, read: (v, at) => v.getFloat32(at, true), norm: 1 },
};
const WIDTH: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

type Json = Record<string, any>;

function splitGlb(data: Uint8Array): { json: Json; bin: Uint8Array | null } {
  if (data.length > 12 && data[0] === 0x67 && data[1] === 0x6c && data[2] === 0x54 && data[3] === 0x46) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let json: Json | null = null;
    let bin: Uint8Array | null = null;
    for (let at = 12; at + 8 <= data.length; ) {
      const length = view.getUint32(at, true);
      const type = view.getUint32(at + 4, true);
      const body = data.subarray(at + 8, at + 8 + length);
      if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(body));
      else if (type === 0x004e4942 && !bin) bin = body;
      at += 8 + length + ((4 - (length % 4)) % 4);
    }
    return { json: json ?? bad('That GLB has no model description in it.'), bin };
  }
  try {
    return { json: JSON.parse(new TextDecoder().decode(data)), bin: null };
  } catch {
    return bad('That is not a GLB or glTF file.');
  }
}

function readGltf(data: Uint8Array): RawMesh {
  const { json, bin } = splitGlb(data);
  const needs = [...(json.extensionsRequired ?? [])] as string[];
  if (needs.includes('KHR_draco_mesh_compression') || needs.includes('EXT_meshopt_compression')) {
    bad('That GLB is compressed (Draco or meshopt). Export it again without compression, or as OBJ or STL.');
  }
  const buffers: Uint8Array[] = (json.buffers ?? []).map((b: Json, i: number) => {
    if (typeof b.uri === 'string') {
      const m = /^data:[^,]*;base64,(.*)$/.exec(b.uri);
      if (!m) return bad('That glTF points at a separate .bin file. Use a single .glb (or one with the data inside it).');
      return Uint8Array.from(atob(m[1]), (c) => c.charCodeAt(0));
    }
    return i === 0 && bin ? bin : bad('That GLB is missing its data.');
  });

  const read = (index: number): { values: number[]; width: number } => {
    const acc: Json = json.accessors?.[index] ?? bad('That GLB names an accessor it does not have.');
    if (acc.sparse) bad('That GLB uses sparse data, which Autora 3D does not read.');
    const comp = COMPONENT[acc.componentType] ?? bad('That GLB uses a data type Autora 3D does not read.');
    const width = WIDTH[acc.type] ?? bad('That GLB uses a data layout Autora 3D does not read.');
    const view: Json = json.bufferViews?.[acc.bufferView] ?? bad('That GLB names data it does not have.');
    const buf = buffers[view.buffer] ?? bad('That GLB names a buffer it does not have.');
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const stride = view.byteStride || comp.size * width;
    const base = (view.byteOffset ?? 0) + (acc.byteOffset ?? 0);
    if (base + (acc.count - 1) * stride + comp.size * width > buf.byteLength) bad('That GLB is cut short.');
    const values: number[] = [];
    for (let i = 0; i < acc.count; i++) {
      for (let k = 0; k < width; k++) {
        const v = comp.read(dv, base + i * stride + k * comp.size);
        values.push(acc.normalized ? Math.max(v / comp.norm, -1) : v);
      }
    }
    return { values, width };
  };

  const positions: number[] = [];
  const indices: number[] = [];
  const uvs: number[] = [];
  let laidOut = true;
  let color: string | undefined;
  let image: string | undefined;

  /** The base colour picture a material names, when it is inside the file as a PNG or JPEG. */
  const pictureOf = (materialIndex: number | undefined): string | undefined => {
    const tex = materialIndex === undefined ? undefined : json.materials?.[materialIndex]?.pbrMetallicRoughness?.baseColorTexture;
    if (!tex || (tex.texCoord ?? 0) !== 0) return undefined;
    const img: Json | undefined = json.images?.[json.textures?.[tex.index]?.source];
    if (!img) return undefined;
    let bytes: Uint8Array | null = null;
    if (typeof img.uri === 'string') {
      const m = /^data:image\/(?:png|jpeg);base64,(.*)$/.exec(img.uri);
      if (m) bytes = Uint8Array.from(atob(m[1]), (c) => c.charCodeAt(0));
    } else if (img.bufferView !== undefined) {
      const view: Json | undefined = json.bufferViews?.[img.bufferView];
      const buf = view ? buffers[view.buffer] : undefined;
      if (view && buf) bytes = buf.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
    }
    if (!bytes || bytes.length > MAX_IMAGE_BYTES) return undefined;
    return imageDataUrl(bytes) ?? undefined;
  };

  const take = (meshIndex: number, world: THREE.Matrix4) => {
    const mesh: Json = json.meshes?.[meshIndex];
    if (!mesh) return;
    const v = new THREE.Vector3();
    for (const prim of mesh.primitives ?? []) {
      const mode = prim.mode ?? 4;
      if (mode < 4 || prim.attributes?.POSITION === undefined) continue;
      const first = positions.length / 3;
      const { values } = read(prim.attributes.POSITION);
      for (let i = 0; i + 2 < values.length; i += 3) {
        v.set(values[i], values[i + 1], values[i + 2]).applyMatrix4(world);
        positions.push(v.x, v.y, v.z);
      }
      if (prim.attributes.TEXCOORD_0 !== undefined && laidOut) {
        const t = read(prim.attributes.TEXCOORD_0).values;
        // glTF's v runs down the picture; a texture's runs up.
        for (let i = 0; i + 1 < t.length; i += 2) uvs.push(t[i], 1 - t[i + 1]);
      } else laidOut = false;
      if (!image) image = pictureOf(prim.material);
      const order = prim.indices !== undefined ? read(prim.indices).values : Array.from({ length: values.length / 3 }, (_, i) => i);
      const tri: number[] = [];
      if (mode === 4) tri.push(...order);
      else if (mode === 5) for (let i = 0; i + 2 < order.length; i++) tri.push(...(i % 2 ? [order[i + 1], order[i], order[i + 2]] : [order[i], order[i + 1], order[i + 2]]));
      else for (let i = 1; i + 1 < order.length; i++) tri.push(order[0], order[i], order[i + 1]);
      for (let i = 0; i + 2 < tri.length; i += 3) {
        const [a, b, c] = [tri[i], tri[i + 1], tri[i + 2]];
        if (a !== b && b !== c && a !== c) indices.push(first + a, first + b, first + c);
      }
      const f = json.materials?.[prim.material]?.pbrMetallicRoughness?.baseColorFactor;
      if (!color && Array.isArray(f) && f.length >= 3) color = `#${[0, 1, 2].map((k) => Math.round(Math.min(1, Math.max(0, srgb(f[k]))) * 255).toString(16).padStart(2, '0')).join('')}`;
    }
  };

  const visit = (index: number, parent: THREE.Matrix4, seen: Set<number>) => {
    const node: Json = json.nodes?.[index];
    if (!node || seen.has(index)) return;
    seen.add(index);
    const local = new THREE.Matrix4();
    if (Array.isArray(node.matrix)) local.fromArray(node.matrix);
    else {
      const t = node.translation ?? [0, 0, 0];
      const r = node.rotation ?? [0, 0, 0, 1];
      const s = node.scale ?? [1, 1, 1];
      local.compose(new THREE.Vector3(...(t as [number, number, number])), new THREE.Quaternion(...(r as [number, number, number, number])), new THREE.Vector3(...(s as [number, number, number])));
    }
    const world = parent.clone().multiply(local);
    if (node.mesh !== undefined) take(node.mesh, world);
    for (const child of node.children ?? []) visit(child, world, seen);
    seen.delete(index);
  };

  const scene: Json | undefined = json.scenes?.[json.scene ?? 0];
  const roots: number[] = scene?.nodes ?? (json.nodes ?? []).map((_: unknown, i: number) => i);
  for (const root of roots) visit(root, new THREE.Matrix4(), new Set());
  if (!roots.length && json.meshes?.length) json.meshes.forEach((_: unknown, i: number) => take(i, new THREE.Matrix4()));
  const layout = laidOut && uvs.length / 2 === positions.length / 3 && uvs.length > 0;
  return { positions, indices, color, ...(layout ? { uvs } : {}), ...(layout && image ? { image } : {}) };
}

/** glTF colours are linear; the shape's colour is sRGB, as a colour picker shows it. */
const srgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

// ---- Fewer triangles -----------------------------------------------------------------------------

/**
 * Brings a mesh down to `max` triangles by vertex clustering: every vertex in one cell of a grid becomes their average, and
 * triangles that fall in on themselves go. Coarse, but a silhouette (a horse's legs, ears and tail) survives; a mesh already
 * under the limit is returned as it is.
 */
export function simplify(mesh: RawMesh, max = MAX_TRIANGLES): RawMesh {
  if (mesh.indices.length / 3 <= max) return mesh;
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  for (let i = 0; i < mesh.positions.length; i += 3) box.expandByPoint(v.set(mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]));
  const size = box.getSize(new THREE.Vector3());
  const longest = Math.max(size.x, size.y, size.z) || 1;
  let cells = Math.ceil(Math.cbrt(max) * 6);
  for (;;) {
    const cell = longest / cells;
    const slot = new Map<string, number>();
    const sums: number[] = [];
    const counts: number[] = [];
    const remap = new Array<number>(mesh.positions.length / 3);
    for (let i = 0; i < remap.length; i++) {
      const x = mesh.positions[i * 3];
      const y = mesh.positions[i * 3 + 1];
      const z = mesh.positions[i * 3 + 2];
      const k = `${Math.floor((x - box.min.x) / cell)},${Math.floor((y - box.min.y) / cell)},${Math.floor((z - box.min.z) / cell)}`;
      let n = slot.get(k);
      if (n === undefined) {
        n = counts.length;
        slot.set(k, n);
        counts.push(0);
        sums.push(0, 0, 0);
      }
      remap[i] = n;
      counts[n]++;
      sums[n * 3] += x;
      sums[n * 3 + 1] += y;
      sums[n * 3 + 2] += z;
    }
    const indices = dropFlat(mesh.indices.map((i) => remap[i]));
    if (indices.length / 3 <= max || cells < 8) {
      const positions = counts.flatMap((c, n) => [sums[n * 3] / c, sums[n * 3 + 1] / c, sums[n * 3 + 2] / c]);
      // Clustering merges vertices from all over a picture: its layout no longer fits, so it goes (and the picture with it).
      const { uvs: _u, image: _i, ...rest } = mesh;
      return { ...rest, positions, indices };
    }
    cells = Math.floor(cells * 0.85);
  }
}

// ---- Into a shape --------------------------------------------------------------------------------

export interface MeshPlacement {
  /** Which way is up in the file. glTF is "y"; STL is usually "z"; OBJ varies (Blender writes "y"). */
  up?: 'y' | 'z';
  /** The longest side the shape gets, mm. Without it the file's own units are kept (glTF is in metres). */
  size?: number;
  /** Where the footprint centre goes, mm. */
  x?: number;
  y?: number;
  /** With no x: put it this far right of the shapes already there (their right edge and the middle of their depth). */
  beside?: { maxX: number; centerY: number };
  /** Height of its underside above the ground. */
  elevation?: number;
}

export interface MeshShape {
  mesh: MeshData;
  points: Point2D[];
  height: number;
  /** The factor the file's numbers were multiplied by to get millimetres. */
  scale: number;
  triangles: number;
  /** How many the file had, when it was simplified. */
  from?: number;
  color?: string;
  /** The file's own picture, laid on by its own UVs (in `mesh.uvs`). */
  image?: string;
}

/** The units a format is normally written in, relative to millimetres. */
export const UNIT: Record<MeshFormat, number> = { glb: 1000, obj: 1, stl: 1 };
export const UP: Record<MeshFormat, 'y' | 'z'> = { glb: 'y', obj: 'y', stl: 'z' };

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Puts a mesh in the model's space: millimetres, z up, centred on its footprint and standing on the ground. A mesh is kept
 * as `[x, y, height]` triples (x, y on the ground, height above its underside), so moving and turning a shape move its mesh the
 * way they move any outline.
 */
export function placeMesh(raw: RawMesh, format: MeshFormat, at: MeshPlacement = {}): MeshShape {
  const total = raw.indices.length / 3;
  const mesh = simplify(raw);
  const up = at.up ?? UP[format];
  const n = mesh.positions.length / 3;
  const x = new Array<number>(n);
  const y = new Array<number>(n);
  const z = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const [a, b, c] = [mesh.positions[i * 3], mesh.positions[i * 3 + 1], mesh.positions[i * 3 + 2]];
    // Y-up files: the world's z runs toward the viewer, so the ground's y is minus it (the model stays facing the same way).
    x[i] = a;
    y[i] = up === 'y' ? -c : b;
    z[i] = up === 'y' ? b : c;
  }
  const lo = [Math.min(...x), Math.min(...y), Math.min(...z)];
  const hi = [Math.max(...x), Math.max(...y), Math.max(...z)];
  const longest = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  if (!(longest > 0) || !Number.isFinite(longest)) bad('That mesh has no size (all its points are the same).');

  let scale = UNIT[format];
  if (at.size !== undefined) {
    if (!(at.size >= 1)) bad('size must be at least 1 mm.');
    scale = at.size / longest;
  } else if (longest * scale < 5 || longest * scale > 2000) {
    // The file's units were a guess that came out as a speck or a building: fit it to something to work on.
    scale = 100 / longest;
  }
  const half = { x: Math.max(0.5, ((hi[0] - lo[0]) * scale) / 2), y: Math.max(0.5, ((hi[1] - lo[1]) * scale) / 2) };
  const cx = at.x ?? (at.beside ? Math.round(at.beside.maxX + 50 + half.x) : 0);
  const cy = at.y ?? (at.beside ? Math.round(at.beside.centerY) : 0);
  const ox = (lo[0] + hi[0]) / 2;
  const oy = (lo[1] + hi[1]) / 2;
  const positions: number[] = new Array(n * 3);
  for (let i = 0; i < n; i++) {
    positions[i * 3] = r3(cx + (x[i] - ox) * scale);
    positions[i * 3 + 1] = r3(cy + (y[i] - oy) * scale);
    positions[i * 3 + 2] = r3((z[i] - lo[2]) * scale);
  }
  return {
    mesh: { positions, indices: mesh.indices, ...(mesh.uvs && mesh.uvs.length / 2 === n ? { uvs: mesh.uvs } : {}) },
    points: [
      { x: r3(cx - half.x), y: r3(cy - half.y) },
      { x: r3(cx + half.x), y: r3(cy - half.y) },
      { x: r3(cx + half.x), y: r3(cy + half.y) },
      { x: r3(cx - half.x), y: r3(cy + half.y) },
    ],
    height: Math.max(1, r3((hi[2] - lo[2]) * scale)),
    scale,
    triangles: mesh.indices.length / 3,
    ...(mesh.indices.length < raw.indices.length ? { from: total } : {}),
    color: raw.color,
    ...(mesh.uvs && mesh.image ? { image: mesh.image } : {}),
  };
}

/** A mesh shape's raw solid, Y-up the way every body's is, standing on its elevation (shading is added by buildBodyGeometry). */
export function meshGeometry(body: Body3D): THREE.BufferGeometry | null {
  const m = body.mesh;
  if (!m || m.indices.length < 3) return null;
  const n = m.positions.length / 3;
  const pos = new Float32Array(n * 3);
  const lift = body.elevation ?? 0;
  for (let i = 0; i < n; i++) {
    pos[i * 3] = m.positions[i * 3];
    pos[i * 3 + 1] = m.positions[i * 3 + 2] + lift;
    pos[i * 3 + 2] = -m.positions[i * 3 + 1];
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  if (m.uvs && m.uvs.length === n * 2) geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(m.uvs), 2));
  geometry.setIndex(new THREE.BufferAttribute(n > 65535 ? new Uint32Array(m.indices) : new Uint16Array(m.indices), 1));
  return geometry;
}
