/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A shape's surface: what it is made of (its finish, from a preset with the shape's own numbers on top), the patterns the
 * modeller draws itself, and where an image or pattern sits on the shape (UVs). Needs no DOM, so the viewer, the GLB
 * export and the headless engine share one idea of every surface.
 */
import * as THREE from 'three';
import { Body3D, MATERIAL_PRESETS, PatternKind, Surface, SurfaceImage, SurfacePattern } from '../types';

/** Every number a surface has, resolved: the preset's, with the shape's own on top. */
export interface ResolvedSurface {
  color: string;
  roughness: number;
  metalness: number;
  opacity: number;
  transmission: number;
  ior: number;
  thickness: number;
  clearcoat: number;
  sheen: number;
  sheenColor: string;
  glow: number;
  subsurface: number;
  pattern?: SurfacePattern;
  image?: SurfaceImage;
}

/** The range each number of a surface may take. The engine holds values to these; the window's sliders run over them. */
export const SURFACE_RANGES = {
  roughness: [0, 1],
  metalness: [0, 1],
  opacity: [0.05, 1],
  transmission: [0, 1],
  ior: [1, 2.5],
  thickness: [0, 200],
  clearcoat: [0, 1],
  sheen: [0, 1],
  glow: [0, 5],
  subsurface: [0, 1],
} as const satisfies Record<string, readonly [number, number]>;
export type SurfaceNumber = keyof typeof SURFACE_RANGES;
export const SURFACE_NUMBERS = Object.keys(SURFACE_RANGES) as SurfaceNumber[];

export const PATTERNS: { kind: PatternKind; label: string }[] = [
  { kind: 'none', label: 'None' },
  { kind: 'wood', label: 'Wood' },
  { kind: 'marble', label: 'Marble' },
  { kind: 'noise', label: 'Speckle' },
  { kind: 'weave', label: 'Fabric' },
  { kind: 'scales', label: 'Scales' },
  { kind: 'brushed', label: 'Brushed' },
  { kind: 'checker', label: 'Checker' },
  { kind: 'dots', label: 'Dots' },
];
export const PATTERN_KINDS = PATTERNS.map((p) => p.kind);

/** A pattern as it starts when a person or the agent picks one. */
export const DEFAULT_PATTERN: Omit<SurfacePattern, 'kind'> = { color2: '#3f2a1d', scale: 60, bump: 0.3, angle: 0 };

export const presetOf = (body: Pick<Body3D, 'materialType'>) => MATERIAL_PRESETS.find((p) => p.id === body.materialType) ?? MATERIAL_PRESETS[0];

export function resolveSurface(body: Pick<Body3D, 'materialType' | 'color' | 'surface'>): ResolvedSurface {
  const p = presetOf(body);
  const s: Surface = body.surface ?? {};
  const pick = (k: SurfaceNumber, base: number) => (typeof s[k] === 'number' && Number.isFinite(s[k]) ? (s[k] as number) : base);
  return {
    color: body.color || p.color,
    roughness: pick('roughness', p.roughness),
    metalness: pick('metalness', p.metalness),
    opacity: pick('opacity', p.opacity ?? 1),
    transmission: pick('transmission', p.transmission ?? 0),
    ior: pick('ior', p.ior ?? 1.5),
    thickness: pick('thickness', p.thickness ?? (p.transmission ? 8 : 0)),
    clearcoat: pick('clearcoat', p.clearcoat ?? (p.id === 'glossy' ? 1 : 0)),
    sheen: pick('sheen', p.sheen ?? 0),
    // Empty: a paler shade of the shape's own colour, as cloth has.
    sheenColor: s.sheenColor ?? '',
    glow: pick('glow', p.emissiveIntensity ?? 0),
    subsurface: pick('subsurface', p.subsurface ?? 0),
    ...(s.pattern && s.pattern.kind !== 'none' ? { pattern: s.pattern } : {}),
    ...(s.image ? { image: s.image } : {}),
  };
}

/** A few words for what a surface is, for the agent's summaries and the window's chips. */
export function describeSurface(body: Pick<Body3D, 'materialType' | 'color' | 'surface'>): string {
  const r = resolveSurface(body);
  const words: string[] = [presetOf(body).name];
  if (body.surface && SURFACE_NUMBERS.some((k) => body.surface![k] !== undefined)) words.push('adjusted');
  if (r.pattern) words.push(`${PATTERNS.find((p) => p.kind === r.pattern!.kind)?.label.toLowerCase()} pattern`);
  if (r.image) words.push('image');
  return words.join(', ');
}

// ---- Where a picture sits on a shape ------------------------------------------------------------

/** Millimetres per unit of UV: textures are scaled against this (a repeat of `scale` mm is `UV_MM / scale` repeats). */
export const UV_MM = 100;

/**
 * Lays every triangle onto the side of a box it faces most (box projection), so a pattern or an image sits on any shape
 * without seams across a face. The geometry must be non-indexed (each triangle its own three corners).
 */
export function addBoxUVs(geometry: THREE.BufferGeometry): void {
  const pos = geometry.getAttribute('position');
  if (!pos || geometry.getIndex()) return;
  const uv = new Float32Array(pos.count * 2);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (let t = 0; t + 2 < pos.count; t += 3) {
    a.fromBufferAttribute(pos, t);
    b.fromBufferAttribute(pos, t + 1);
    c.fromBufferAttribute(pos, t + 2);
    n.subVectors(b, a).cross(c.clone().sub(a));
    const ax = Math.abs(n.x);
    const ay = Math.abs(n.y);
    const az = Math.abs(n.z);
    for (let k = 0; k < 3; k++) {
      const p = k === 0 ? a : k === 1 ? b : c;
      let u: number;
      let v: number;
      if (ay >= ax && ay >= az) { u = p.x; v = n.y > 0 ? -p.z : p.z; }
      else if (ax >= az) { u = n.x > 0 ? -p.z : p.z; v = p.y; }
      else { u = n.z > 0 ? p.x : -p.x; v = p.y; }
      uv[(t + k) * 2] = u / UV_MM;
      uv[(t + k) * 2 + 1] = v / UV_MM;
    }
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

/** True when a mesh shape's own UVs (from its file) still fit its surface. */
export const hasOwnUVs = (body: Pick<Body3D, 'mesh'>) => !!body.mesh?.uvs && body.mesh.uvs.length / 2 === body.mesh.positions.length / 3;

/** How many times a texture repeats per unit of UV on this shape. */
export function textureRepeat(body: Pick<Body3D, 'mesh' | 'surface'>, which: 'pattern' | 'image'): number {
  const s = body.surface;
  if (which === 'image') {
    if (hasOwnUVs(body) && !s?.image?.scale) return 1;
    return UV_MM / Math.max(1, s?.image?.scale ?? 100);
  }
  return UV_MM / Math.max(1, s?.pattern?.scale ?? DEFAULT_PATTERN.scale);
}

// ---- Patterns -------------------------------------------------------------------------------------

/** A pattern as pixels: colour (RGBA, sRGB) and relief (0..255), one tile that repeats without a seam. */
export interface PatternPixels {
  size: number;
  rgba: Uint8Array;
  height: Uint8Array;
}

const fract = (x: number) => x - Math.floor(x);
const mixc = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (t: number) => t * t * (3 - 2 * t);

/** Value noise that repeats every `period` cells, so the tile has no seam. */
function tiledNoise(seed: number) {
  const hash = (x: number, y: number) => {
    let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  };
  const noise = (u: number, v: number, period: number) => {
    const x = u * period;
    const y = v * period;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const tx = smooth(x - x0);
    const ty = smooth(y - y0);
    const w = (i: number) => ((i % period) + period) % period;
    const a = hash(w(x0), w(y0));
    const b = hash(w(x0 + 1), w(y0));
    const c = hash(w(x0), w(y0 + 1));
    const d = hash(w(x0 + 1), w(y0 + 1));
    return mixc(mixc(a, b, tx), mixc(c, d, tx), ty);
  };
  const fbm = (u: number, v: number, base = 4, octaves = 4) => {
    let sum = 0;
    let amp = 0.5;
    let total = 0;
    for (let o = 0; o < octaves; o++) {
      sum += noise(u, v, base << o) * amp;
      total += amp;
      amp *= 0.5;
    }
    return sum / total;
  };
  return { noise, fbm };
}

const rgbOf = (hex: string): [number, number, number] => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const n = m ? parseInt(m[1], 16) : 0x888888;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

/**
 * Draws one tile of a pattern in the shape's colour and the pattern's second colour. `t` is how much of the second colour
 * a pixel has and `h` its relief. Seeded, so the same pattern always draws the same.
 */
export function patternPixels(kind: PatternKind, color: string, color2: string, size = 256, seed = 7): PatternPixels {
  const { noise, fbm } = tiledNoise(seed);
  const c1 = rgbOf(color);
  const c2 = rgbOf(color2);
  const rgba = new Uint8Array(size * size * 4);
  const height = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      let t = 0;
      let h = 0.5;
      switch (kind) {
        case 'wood': {
          // Rings across the grain, wobbling with the wood's own unevenness, and fine streaks along it.
          const r = u * 6 + (fbm(u, v, 2, 3) - 0.5) * 2.2;
          const ring = fract(r);
          const grain = noise(u, v, 64) * 0.25;
          t = Math.min(1, Math.pow(ring, 3) * 0.85 + grain);
          h = 1 - t * 0.8;
          break;
        }
        case 'marble': {
          const s = Math.sin((u + v) * Math.PI * 2 * 2 + fbm(u, v, 4, 5) * 9);
          const vein = Math.pow(1 - Math.abs(s), 6);
          t = Math.min(1, vein + fbm(u, v, 8, 3) * 0.12);
          h = 0.5 + (1 - vein) * 0.1;
          break;
        }
        case 'noise': {
          const f = fbm(u, v, 16, 3);
          t = smooth(Math.min(1, Math.max(0, (f - 0.35) * 2.2)));
          h = f;
          break;
        }
        case 'weave': {
          // Threads over and under: each cell is a thread across or along, whichever is on top there.
          const n = 8;
          const cx = Math.floor(u * n);
          const cy = Math.floor(v * n);
          const along = (cx + cy) % 2 === 0;
          const across = along ? fract(v * n) : fract(u * n);
          const round = Math.sin(across * Math.PI);
          t = along ? 0.15 + (1 - round) * 0.5 : 0.65 + (1 - round) * 0.35;
          h = round * 0.9 + noise(u, v, 128) * 0.1;
          break;
        }
        case 'scales': {
          // Rows of overlapping round scales, each row half a scale along from the last.
          const n = 6;
          const row = Math.floor(v * n);
          const su = u * n + (row % 2) * 0.5;
          const sv = fract(v * n);
          const du = fract(su) - 0.5;
          const d = Math.hypot(du, sv) / 0.75;
          const edge = smooth(Math.min(1, Math.max(0, d)));
          t = edge * 0.9;
          h = 1 - edge;
          break;
        }
        case 'brushed': {
          // Streaks along the surface: noise stretched far along one way.
          const s = noise(u * 0.02, v, 256) * 0.6 + noise(u * 0.05, v, 128) * 0.4;
          t = s * 0.6;
          h = s;
          break;
        }
        case 'checker': {
          t = (Math.floor(u * 2) + Math.floor(v * 2)) % 2;
          h = 0.5;
          break;
        }
        case 'dots': {
          const n = 4;
          const d = Math.hypot(fract(u * n) - 0.5, fract(v * n) - 0.5);
          const dot = 1 - smooth(Math.min(1, Math.max(0, (d - 0.22) / 0.04)));
          t = dot;
          h = 0.5 + dot * 0.4;
          break;
        }
        default:
          t = 0;
      }
      const i = y * size + x;
      rgba[i * 4] = Math.round(mixc(c1[0], c2[0], t));
      rgba[i * 4 + 1] = Math.round(mixc(c1[1], c2[1], t));
      rgba[i * 4 + 2] = Math.round(mixc(c1[2], c2[2], t));
      rgba[i * 4 + 3] = 255;
      height[i] = Math.round(Math.min(1, Math.max(0, h)) * 255);
    }
  }
  return { size, rgba, height };
}

// ---- Pictures as files (for GLB) -------------------------------------------------------------------

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (bytes: Uint8Array) => {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

/** An uncompressed PNG (deflate's stored blocks): no zlib needed, so it is written the same in the page and in Node. */
export function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const rowLen = width * 4 + 1;
  const raw = new Uint8Array(rowLen * height);
  for (let y = 0; y < height; y++) {
    raw[y * rowLen] = 0;
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * rowLen + 1);
  }
  const blocks = Math.ceil(raw.length / 65535) || 1;
  const z = new Uint8Array(2 + raw.length + blocks * 5 + 4);
  z[0] = 0x78;
  z[1] = 0x01;
  let o = 2;
  for (let b = 0; b < blocks; b++) {
    const part = raw.subarray(b * 65535, Math.min(raw.length, (b + 1) * 65535));
    z[o++] = b === blocks - 1 ? 1 : 0;
    z[o++] = part.length & 255;
    z[o++] = part.length >> 8;
    z[o++] = ~part.length & 255;
    z[o++] = (~part.length >> 8) & 255;
    z.set(part, o);
    o += part.length;
  }
  let s1 = 1;
  let s2 = 0;
  for (let i = 0; i < raw.length; i++) {
    s1 = (s1 + raw[i]) % 65521;
    s2 = (s2 + s1) % 65521;
  }
  const adler = ((s2 << 16) | s1) >>> 0;
  z[o++] = adler >>> 24;
  z[o++] = (adler >>> 16) & 255;
  z[o++] = (adler >>> 8) & 255;
  z[o++] = adler & 255;

  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const hv = new DataView(ihdr.buffer);
  hv.setUint32(0, width);
  hv.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', z), chunk('IEND', new Uint8Array(0))];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const png = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    png.set(p, at);
    at += p.length;
  }
  return png;
}

/** The largest picture a surface keeps, as bytes. */
export const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

/** The bytes and type of an image data URL, or null when it is not a PNG or JPEG one. */
export function imageBytes(dataUrl: string): { mime: 'image/png' | 'image/jpeg'; bytes: Uint8Array } | null {
  const m = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl);
  if (!m) return null;
  const bin = atob(m[2].replace(/\s+/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { mime: m[1] as 'image/png' | 'image/jpeg', bytes };
}

/** An image file's bytes as a data URL, when they are a PNG or a JPEG (read from the bytes, not a name). */
export function imageDataUrl(bytes: Uint8Array): string | null {
  const png = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const jpg = bytes[0] === 0xff && bytes[1] === 0xd8;
  if (!png && !jpg) return null;
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:image/${png ? 'png' : 'jpeg'};base64,${btoa(bin)}`;
}

// ---- One copy of each picture -------------------------------------------------------------------

/** The pictures in use, each kept once: the same picture arriving again (a save, an undo, the agent's call) is this one. */
const canonical = new Map<string, string>();
/** Image records already pointing at the kept copy (strings cannot be told apart by identity, their holders can). */
const shared = new WeakSet<object>();

/**
 * Makes every picture in these shapes the one copy kept of it, so models that differ only elsewhere (a history of edits,
 * an undo stack, the command log) share one picture instead of holding a copy each. Each image record is looked at once;
 * returns the same array when nothing changed.
 */
export function sharePictures(bodies: Body3D[]): Body3D[] {
  let changed = false;
  const out = bodies.map((b) => {
    const img = b.surface?.image;
    if (!img || shared.has(img)) return b;
    const mid = img.data.length >> 1;
    const key = `${img.data.length}:${img.data.slice(mid, mid + 64)}:${img.data.slice(-64)}`;
    const kept = canonical.get(key);
    if (kept !== undefined && kept === img.data) {
      // The same picture as one already kept: point at that copy, and let this one go.
      const one = { ...img, data: kept };
      shared.add(one);
      changed = true;
      return { ...b, surface: { ...b.surface!, image: one } };
    }
    canonical.set(key, img.data);
    if (canonical.size > 64) canonical.delete(canonical.keys().next().value as string);
    shared.add(img);
    return b;
  });
  return changed ? out : bodies;
}
