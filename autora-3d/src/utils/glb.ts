/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import * as THREE from 'three';
import { Body3D, ShapeGroup } from '../types';
import { buildBodyGeometry } from './bodyGeometry';
import { frameMatrix } from './frame';
import { encodePng, imageBytes, patternPixels, resolveSurface, textureRepeat } from './surface';
import { EXPORT_STRANDS, EXPORT_STRANDS_TOTAL, hairGeometry, settleHair } from './hair';

export interface GlbOptions {
  /** Scene units per metre of output. Default 0.001: our mm become glTF metres, which is what game engines expect. */
  scale?: number;
  /**
   * Where each shape's origin sits. "scene" keeps the placement you see; "asset" centres the whole export on the ground
   * (its footprint centre at x/z 0, its lowest point at y 0); "shape" gives every shape its own pivot at the centre of its
   * base, so each can be moved or spun alone in an engine.
   */
  pivot?: 'scene' | 'asset' | 'shape';
  /** The document's groups: each becomes a named parent node holding its shapes and inner groups (so "head" arrives as "head"). */
  groups?: ShapeGroup[];
  /** Write the hair and fur (default true). Each shape's is capped (EXPORT_STRANDS, and EXPORT_STRANDS_TOTAL for the file). */
  hair?: boolean;
}

const pad = (n: number) => (4 - (n % 4)) % 4;

/** A binary glTF (.glb), Y-up, in metres: one named node + PBR material per visible shape. Needs no DOM. Null when nothing is visible. */
export function glbBytes(bodies: Body3D[], options: GlbOptions = {}): Uint8Array | null {
  const unit = options.scale ?? 0.001;
  const pivot = options.pivot ?? 'scene';
  /** One mesh to write: a shape's solid, or the hair grown on it (`hair`), which carries a colour per vertex. */
  type Part = { body: Body3D; pos: Float32Array; nrm: Float32Array; idx: Uint32Array; min: THREE.Vector3; max: THREE.Vector3; uv?: Float32Array; col?: Float32Array; hair?: boolean; baseRepeat?: number };
  const parts: Part[] = [];
  const growing: { body: Body3D; g: THREE.BufferGeometry; m: THREE.Matrix4; normalMatrix: THREE.Matrix3 }[] = [];
  const withHair = options.hair === false ? 0 : bodies.filter((b) => b.visible && b.hair).length;
  // One file's hair stays a size an engine takes: each shape's share of the file's cap, and never more than a shape's own cap.
  const most = Math.max(100, Math.min(EXPORT_STRANDS, Math.floor(EXPORT_STRANDS_TOTAL / Math.max(1, withHair))));
  for (const body of bodies) {
    if (!body.visible) continue;
    const g = buildBodyGeometry(body);
    if (!g) continue;
    const m = body.frame ? frameMatrix(body.frame) : new THREE.Matrix4();
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(m);
    const p = g.getAttribute('position');
    const n = g.getAttribute('normal');
    const pos = new Float32Array(p.count * 3);
    const nrm = new Float32Array(p.count * 3);
    const v = new THREE.Vector3();
    const min = new THREE.Vector3(Infinity, Infinity, Infinity);
    const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(m);
      pos.set([v.x, v.y, v.z], i * 3);
      min.min(v);
      max.max(v);
      if (n) {
        v.fromBufferAttribute(n, i).applyMatrix3(normalMatrix).normalize();
        nrm.set([v.x, v.y, v.z], i * 3);
      }
    }
    const index = g.getIndex();
    const idx = new Uint32Array(index ? index.count : p.count);
    for (let i = 0; i < idx.length; i++) idx[i] = index ? index.getX(i) : i;
    if (!n) {
      const tmp = new THREE.BufferGeometry();
      tmp.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      tmp.setIndex(new THREE.BufferAttribute(idx, 1));
      tmp.computeVertexNormals();
      nrm.set(tmp.getAttribute('normal').array as Float32Array);
    }
    // A pattern or picture repeats every so many mm: glTF has no repeat of its own here, so it is written into the UVs.
    const s = resolveSurface(body);
    const uvAttr = g.getAttribute('uv');
    let uv: Float32Array | undefined;
    // The UVs carry the repeat of the colour picture or pattern (else the roughness picture's); another texture's own repeat
    // is a KHR_texture_transform scale on top (texRepeat in surfaceMaterial).
    const roughOut = !!s.roughnessImage && s.metalness <= 0.05;
    const baseSlot = s.image ? 'image' : s.pattern ? 'pattern' : roughOut ? 'roughnessImage' : null;
    if (uvAttr && baseSlot) {
      const repeat = textureRepeat(body, baseSlot);
      const turn = s.image ? 0 : THREE.MathUtils.degToRad(s.pattern?.angle ?? 0);
      const [c, sn] = [Math.cos(turn), Math.sin(turn)];
      uv = new Float32Array(uvAttr.count * 2);
      for (let i = 0; i < uvAttr.count; i++) {
        const u = uvAttr.getX(i) * repeat;
        const w = uvAttr.getY(i) * repeat;
        // glTF's v runs down the picture.
        uv[i * 2] = u * c - w * sn;
        uv[i * 2 + 1] = 1 - (u * sn + w * c);
      }
    }
    parts.push({ body, pos, nrm, idx, min, max, uv, baseRepeat: baseSlot ? textureRepeat(body, baseSlot) : 1 });
    if (body.hair && options.hair !== false) growing.push({ body, g, m, normalMatrix });
  }
  // Hair, once every shape is known: it rests on the others rather than passing through them (their boxes, in the world).
  for (const { body, g, m, normalMatrix } of growing) {
    const v = new THREE.Vector3();
    const others = parts.filter((q) => q.body.id !== body.id && !q.hair).map((q) => ({ box: new THREE.Box3(q.min.clone(), q.max.clone()), round: !!q.body.mesh }));
    // Hair is grown in the shape's own space; an upright shape's (the only kind with hair) is the world's.
    const obstacles = body.frame ? [] : others;
    {
      // The hair is grown as it is drawn (fur too, as short strands): its own node beside the shape, coloured root to tip.
      const strands = hairGeometry(g, settleHair(body.hair!), body.elevation ?? 0, most, obstacles);
      if (strands) {
        const hp = strands.getAttribute('position');
        const hn = strands.getAttribute('normal');
        const hc = strands.getAttribute('color');
        const hpos = new Float32Array(hp.count * 3);
        const hnrm = new Float32Array(hp.count * 3);
        const hmin = new THREE.Vector3(Infinity, Infinity, Infinity);
        const hmax = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
        for (let i = 0; i < hp.count; i++) {
          v.fromBufferAttribute(hp, i).applyMatrix4(m);
          hpos.set([v.x, v.y, v.z], i * 3);
          hmin.min(v);
          hmax.max(v);
          v.fromBufferAttribute(hn, i).applyMatrix3(normalMatrix).normalize();
          hnrm.set([v.x, v.y, v.z], i * 3);
        }
        parts.push({ body, pos: hpos, nrm: hnrm, idx: new Uint32Array(strands.getIndex()!.array), min: hmin, max: hmax, col: new Float32Array(hc.array as Float32Array), hair: true });
      }
    }
  }
  if (!parts.length) return null;

  const all = new THREE.Box3();
  parts.forEach((q) => all.union(new THREE.Box3(q.min, q.max)));
  const assetShift = new THREE.Vector3((all.min.x + all.max.x) / 2, all.min.y, (all.min.z + all.max.z) / 2);

  const nodes: object[] = [];
  const partNode = new Map<string, number>();
  const partOrigin = new Map<string, THREE.Vector3>();
  const hairNodes = new Set<number>();
  const extensions = new Set<string>();

  /** A picture inside the file, once per picture. */
  const imageIndex = new Map<string, number>();
  const addImage = (key: string, bytes: Uint8Array, mime: string) => {
    const known = imageIndex.get(key);
    if (known !== undefined) return known;
    images.push({ bufferView: addView(bytes, 0), mimeType: mime });
    textures.push({ source: images.length - 1, sampler: 0 });
    imageIndex.set(key, textures.length - 1);
    return textures.length - 1;
  };

  /** A shape's surface as glTF PBR, with the extensions engines read for glass, cloth, lacquer and glow. */
  const surfaceMaterial = (body: Body3D, laidOut: boolean, baseRepeat = 1): Record<string, any> => {
    const s = resolveSurface(body);
    const c = new THREE.Color(s.color); // THREE.Color reads hex as sRGB and stores linear
    const m: Record<string, any> = {
      name: `${body.name}_${body.materialType}`.replace(/\s+/g, '_'),
      pbrMetallicRoughness: { baseColorFactor: [c.r, c.g, c.b, s.opacity], metallicFactor: s.metalness, roughnessFactor: s.roughness },
    };
    const ext: Record<string, any> = {};
    if (laidOut && s.image) {
      const pic = imageBytes(s.image.data);
      if (pic) m.pbrMetallicRoughness.baseColorTexture = { index: addImage(s.image.data.slice(0, 64) + s.image.data.length, pic.bytes, pic.mime) };
    } else if (laidOut && s.pattern) {
      const px = patternPixels(s.pattern.kind, s.color, s.pattern.color2);
      m.pbrMetallicRoughness.baseColorTexture = { index: addImage(`pattern|${s.pattern.kind}|${s.color}|${s.pattern.color2}`, encodePng(px.size, px.size, px.rgba), 'image/png') };
      m.pbrMetallicRoughness.baseColorFactor = [1, 1, 1, s.opacity];
    }
    // A roughness picture goes in glTF's metallic-roughness texture, which reads roughness from green and metal from blue: a grey
    // picture would make a metal's metalness follow it, so it is written only for a non-metal (whose metal factor is 0).
    if (laidOut && s.roughnessImage && s.metalness <= 0.05) {
      const pic = imageBytes(s.roughnessImage.data);
      if (pic) {
        const ratio = textureRepeat(body, 'roughnessImage') / baseRepeat;
        const ref: Record<string, any> = { index: addImage(`r|${s.roughnessImage.data.slice(0, 64)}${s.roughnessImage.data.length}`, pic.bytes, pic.mime) };
        if (Math.abs(ratio - 1) > 1e-6) {
          ref.extensions = { KHR_texture_transform: { scale: [ratio, ratio] } };
          extensions.add('KHR_texture_transform');
        }
        m.pbrMetallicRoughness.metallicRoughnessTexture = ref;
        m.pbrMetallicRoughness.metallicFactor = 0;
      }
    }
    if (s.opacity < 1) m.alphaMode = 'BLEND';
    if (s.transmission > 0) {
      ext.KHR_materials_transmission = { transmissionFactor: s.transmission };
      ext.KHR_materials_ior = { ior: s.ior };
      ext.KHR_materials_volume = { thicknessFactor: s.thickness * unit, attenuationColor: [c.r, c.g, c.b], attenuationDistance: Math.max(10, s.thickness * 6) * unit };
      // An engine that reads none of that still shows it see-through.
      if (s.opacity === 1) {
        m.pbrMetallicRoughness.baseColorFactor[3] = Math.max(0.2, 1 - s.transmission * 0.7);
        m.alphaMode = 'BLEND';
      }
    }
    if (s.clearcoat > 0) ext.KHR_materials_clearcoat = { clearcoatFactor: s.clearcoat, clearcoatRoughnessFactor: 0.08 };
    if (s.sheen > 0) {
      const sc = s.sheenColor ? new THREE.Color(s.sheenColor) : c.clone().lerp(new THREE.Color(1, 1, 1), 0.45);
      ext.KHR_materials_sheen = { sheenColorFactor: [sc.r * s.sheen, sc.g * s.sheen, sc.b * s.sheen], sheenRoughnessFactor: 0.6 };
    }
    if (s.subsurface > 0) ext.KHR_materials_diffuse_transmission = { diffuseTransmissionFactor: s.subsurface * 0.5, diffuseTransmissionColorFactor: [c.r, c.g, c.b] };
    if (s.glow > 0) {
      m.emissiveFactor = [c.r, c.g, c.b];
      if (s.glow > 1) ext.KHR_materials_emissive_strength = { emissiveStrength: s.glow };
    }
    if (Object.keys(ext).length) {
      m.extensions = ext;
      Object.keys(ext).forEach((k) => extensions.add(k));
    }
    return m;
  };

  /** Hair: its colour is per vertex (root to tip), both sides drawn, with a little sheen. */
  const hairMaterial = (body: Body3D): Record<string, any> => {
    const h = settleHair(body.hair!);
    const tip = new THREE.Color(h.tipColor);
    extensions.add('KHR_materials_sheen');
    return {
      name: `${body.name}_hair`.replace(/\s+/g, '_'),
      doubleSided: true,
      pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 0.55 - h.shine * 0.3 },
      extensions: { KHR_materials_sheen: { sheenColorFactor: [tip.r * 0.4, tip.g * 0.4, tip.b * 0.4], sheenRoughnessFactor: 0.4 } },
    };
  };
  const meshes: object[] = [];
  const materials: object[] = [];
  const textures: object[] = [];
  const images: object[] = [];
  const accessors: object[] = [];
  const views: object[] = [];
  const chunks: Uint8Array[] = [];
  let offset = 0;
  const addView = (bytes: Uint8Array, target: number) => {
    // A picture's bytes are not vertex data: its view has no target.
    views.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, ...(target ? { target } : {}) });
    const padded = new Uint8Array(bytes.length + pad(bytes.length));
    padded.set(bytes);
    chunks.push(padded);
    offset += padded.length;
    return views.length - 1;
  };

  for (const q of parts) {
    // Pivot: the point (in scene units) that becomes this node's origin.
    const origin =
      pivot === 'shape' ? new THREE.Vector3((q.min.x + q.max.x) / 2, q.min.y, (q.min.z + q.max.z) / 2) : pivot === 'asset' ? assetShift : new THREE.Vector3();
    const pos = new Float32Array(q.pos.length);
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < pos.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const val = (q.pos[i + k] - (pivot === 'shape' ? origin.getComponent(k) : pivot === 'asset' ? origin.getComponent(k) : 0)) * unit;
        pos[i + k] = val;
        lo[k] = Math.min(lo[k], val);
        hi[k] = Math.max(hi[k], val);
      }
    }
    const aPos = accessors.length;
    accessors.push({ bufferView: addView(new Uint8Array(pos.buffer), 34962), componentType: 5126, count: pos.length / 3, type: 'VEC3', min: lo, max: hi });
    accessors.push({ bufferView: addView(new Uint8Array(q.nrm.buffer), 34962), componentType: 5126, count: q.nrm.length / 3, type: 'VEC3' });
    accessors.push({ bufferView: addView(new Uint8Array(q.idx.buffer), 34963), componentType: 5125, count: q.idx.length, type: 'SCALAR' });

    const material = q.hair ? hairMaterial(q.body) : surfaceMaterial(q.body, !!q.uv, q.baseRepeat);
    materials.push(material);
    const attributes: Record<string, number> = { POSITION: aPos, NORMAL: aPos + 1 };
    if (q.uv) {
      attributes.TEXCOORD_0 = accessors.length;
      accessors.push({ bufferView: addView(new Uint8Array(q.uv.buffer), 34962), componentType: 5126, count: q.uv.length / 2, type: 'VEC2' });
    }
    if (q.col) {
      attributes.COLOR_0 = accessors.length;
      accessors.push({ bufferView: addView(new Uint8Array(q.col.buffer), 34962), componentType: 5126, count: q.col.length / 3, type: 'VEC3' });
    }
    const label = (q.hair ? `${q.body.name}_hair` : q.body.name).replace(/\s+/g, '_');
    meshes.push({ name: label, primitives: [{ attributes, indices: aPos + 2, material: materials.length - 1, mode: 4 }] });
    const node: Record<string, any> = { name: label, mesh: meshes.length - 1 };
    if (pivot === 'shape') node.translation = [origin.x * unit, origin.y * unit, origin.z * unit];
    // With "asset" the shift is baked in, so the node stays at the origin.
    nodes.push(node);
    if (q.hair) {
      // The hair hangs off its shape's node, so it moves with it in an engine.
      const owner = partNode.get(q.body.id);
      if (owner !== undefined) {
        const o = partOrigin.get(q.body.id)!;
        if (pivot === 'shape') node.translation = [(origin.x - o.x) * unit, (origin.y - o.y) * unit, (origin.z - o.z) * unit];
        ((nodes[owner] as Record<string, any>).children ??= []).push(nodes.length - 1);
        hairNodes.add(nodes.length - 1);
      }
      continue;
    }
    partNode.set(q.body.id, nodes.length - 1);
    partOrigin.set(q.body.id, origin.clone());
  }

  // Groups: a named parent node per group. Under "shape" pivots a group's origin is the centre of its base, and children
  // are placed relative to it.
  const groups = (options.groups ?? []).filter((g) => g.bodyIds.some((id) => partNode.has(id)));
  const groupNode = new Map<string, number>();
  const groupOrigin = new Map<string, THREE.Vector3>();
  groups.forEach((g) => {
    const box = new THREE.Box3();
    parts.forEach((q) => g.bodyIds.includes(q.body.id) && box.union(new THREE.Box3(q.min, q.max)));
    groupOrigin.set(g.id, pivot === 'shape' ? new THREE.Vector3((box.min.x + box.max.x) / 2, box.min.y, (box.min.z + box.max.z) / 2) : new THREE.Vector3());
    nodes.push({ name: g.name.replace(/\s+/g, '_'), children: [] as number[] });
    groupNode.set(g.id, nodes.length - 1);
  });
  const rel = (node: Record<string, any>, origin: THREE.Vector3, parent?: THREE.Vector3) => {
    if (pivot !== 'shape') return;
    const d = parent ? origin.clone().sub(parent) : origin;
    node.translation = [d.x * unit, d.y * unit, d.z * unit];
  };
  const placed = new Set<number>();
  groups.forEach((g) => {
    const me = nodes[groupNode.get(g.id)!] as Record<string, any>;
    const parent = g.parentId && groupNode.has(g.parentId) ? g.parentId : undefined;
    rel(me, groupOrigin.get(g.id)!, parent ? groupOrigin.get(parent) : undefined);
    if (parent) {
      (nodes[groupNode.get(parent)!] as any).children.push(groupNode.get(g.id)!);
      placed.add(groupNode.get(g.id)!);
    }
  });
  parts.forEach((q) => {
    const owner = groups.find((g) => g.id === q.body.groupId);
    if (!owner) return;
    const idx = partNode.get(q.body.id)!;
    rel(nodes[idx] as Record<string, any>, partOrigin.get(q.body.id)!, groupOrigin.get(owner.id));
    (nodes[groupNode.get(owner.id)!] as any).children.push(idx);
    placed.add(idx);
  });

  const json = {
    asset: { version: '2.0', generator: 'Autora 3D' },
    scene: 0,
    scenes: [{ nodes: nodes.map((_, i) => i).filter((i) => !placed.has(i) && !hairNodes.has(i)) }],
    nodes,
    meshes,
    materials,
    ...(textures.length ? { textures, images, samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }] } : {}),
    ...(extensions.size ? { extensionsUsed: [...extensions] } : {}),
    accessors,
    bufferViews: views,
    buffers: [{ byteLength: offset }],
  };
  let jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonPadded = new Uint8Array(jsonBytes.length + pad(jsonBytes.length)).fill(0x20);
  jsonPadded.set(jsonBytes);
  jsonBytes = jsonPadded;
  const total = 12 + 8 + jsonBytes.length + 8 + offset;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); // "glTF"
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonBytes.length, true);
  dv.setUint32(16, 0x4e4f534a, true); // "JSON"
  out.set(jsonBytes, 20);
  let at = 20 + jsonBytes.length;
  dv.setUint32(at, offset, true);
  dv.setUint32(at + 4, 0x004e4942, true); // "BIN\0"
  at += 8;
  for (const ch of chunks) {
    out.set(ch, at);
    at += ch.length;
  }
  return out;
}
