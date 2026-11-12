/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * How a shape's surface and hair are drawn in the viewer: the three.js material for a surface (its numbers, pattern,
 * relief and picture), the hair or fur grown on it, and the surroundings the scene is lit by. The page's side of
 * utils/surface.ts and utils/hair.ts (pictures load through the browser here).
 */
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { Body3D, SceneLook } from '../types';
import { furLayers, furPattern, furRepeat, furShell, hairGeometry, settleHair, type GroomAt } from '../utils/hair';
import { patternPixels, resolveSurface, textureRepeat } from '../utils/surface';

// Textures are shared between shapes and kept: a material's dispose never takes them with it.
const patternCache = new Map<string, { map: THREE.DataTexture; bump: THREE.DataTexture }>();
const imageCache = new Map<string, THREE.Texture>();
const CACHE_MOST = 32;

const keep = <T>(cache: Map<string, T>, key: string, make: () => T): T => {
  const hit = cache.get(key);
  if (hit) {
    // Most recently used last, so the oldest is the one let go.
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const made = make();
  cache.set(key, made);
  if (cache.size > CACHE_MOST) cache.delete(cache.keys().next().value as string);
  return made;
};

const tiled = (t: THREE.Texture, repeat: number, angle = 0) => {
  const c = t.clone();
  c.wrapS = c.wrapT = THREE.RepeatWrapping;
  c.repeat.set(repeat, repeat);
  c.rotation = THREE.MathUtils.degToRad(angle);
  c.needsUpdate = true;
  return c;
};

function patternTextures(kind: string, color: string, color2: string) {
  return keep(patternCache, `${kind}|${color}|${color2}`, () => {
    const px = patternPixels(kind as never, color, color2);
    const map = new THREE.DataTexture(px.rgba, px.size, px.size, THREE.RGBAFormat);
    map.colorSpace = THREE.SRGBColorSpace;
    map.generateMipmaps = true;
    map.minFilter = THREE.LinearMipmapLinearFilter;
    map.magFilter = THREE.LinearFilter;
    map.anisotropy = 4;
    map.needsUpdate = true;
    const h = new Uint8Array(px.size * px.size * 4);
    for (let i = 0; i < px.height.length; i++) h.set([px.height[i], px.height[i], px.height[i], 255], i * 4);
    const bump = new THREE.DataTexture(h, px.size, px.size, THREE.RGBAFormat);
    bump.generateMipmaps = true;
    bump.minFilter = THREE.LinearMipmapLinearFilter;
    bump.needsUpdate = true;
    return { map, bump };
  });
}

function imageTexture(data: string, loaded: () => void): THREE.Texture {
  return keep(imageCache, data, () => {
    const t = new THREE.TextureLoader().load(data, () => loaded());
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  });
}

/** Cloth catches light in a paler shade of its own colour. */
export const sheenFrom = (color: string) => `#${new THREE.Color(color).lerp(new THREE.Color('#ffffff'), 0.45).getHexString()}`;

/** The material a shape is drawn with. `loaded` is called when a picture it uses has arrived, so the view draws again. */
export function surfaceMaterial(body: Body3D, loaded: () => void): THREE.Material {
  const s = resolveSurface(body);
  const params: THREE.MeshPhysicalMaterialParameters = {
    color: s.color,
    roughness: s.roughness,
    metalness: s.metalness,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  };
  if (s.pattern) {
    const tex = patternTextures(s.pattern.kind, s.color, s.pattern.color2);
    const repeat = textureRepeat(body, 'pattern');
    params.map = tiled(tex.map, repeat, s.pattern.angle);
    // The pattern carries the colour, so the shape's own colour must not tint it twice.
    params.color = '#ffffff';
    if (s.pattern.bump > 0) {
      params.bumpMap = tiled(tex.bump, repeat, s.pattern.angle);
      params.bumpScale = s.pattern.bump * 3;
    }
  }
  if (s.image) {
    params.map = tiled(imageTexture(s.image.data, loaded), textureRepeat(body, 'image'));
  }
  if (s.opacity < 1) {
    params.transparent = true;
    params.opacity = s.opacity;
    params.depthWrite = false;
  }
  if (s.glow > 0) {
    params.emissive = new THREE.Color(s.color);
    params.emissiveIntensity = s.glow;
    if (params.map) params.emissiveMap = params.map;
  }
  const physical = s.transmission > 0 || s.clearcoat > 0 || s.sheen > 0 || s.subsurface > 0;
  if (!physical) return new THREE.MeshStandardMaterial(params);
  if (s.transmission > 0) {
    // A trace of the glass's own colour stays on it, so clear glass still reads against a dark backdrop.
    params.transmission = Math.min(s.transmission, 0.94);
    if (s.opacity === 1) {
      params.transparent = true;
      params.opacity = 0.92;
    }
    params.ior = s.ior;
    params.thickness = s.thickness;
    params.attenuationColor = new THREE.Color(s.color);
    params.attenuationDistance = Math.max(10, s.thickness * 6);
    params.specularIntensity = 1;
  }
  if (s.clearcoat > 0) {
    params.clearcoat = s.clearcoat;
    params.clearcoatRoughness = 0.08;
  }
  if (s.sheen > 0) {
    params.sheen = s.sheen;
    params.sheenColor = new THREE.Color(s.sheenColor || sheenFrom(s.color));
    params.sheenRoughness = 0.6;
  }
  if (s.subsurface > 0 && s.transmission === 0) {
    // Light through the skin: a soft, rough transmission tinted by the colour and fading fast, with a warm sheen at the rim.
    params.transmission = s.subsurface * 0.45;
    params.thickness = 20;
    params.ior = 1.4;
    params.attenuationColor = new THREE.Color(s.color).lerp(new THREE.Color('#ff3b1f'), 0.35);
    params.attenuationDistance = 6;
    params.roughness = Math.max(s.roughness, 0.45);
    if (s.sheen === 0) {
      params.sheen = s.subsurface * 0.5;
      params.sheenColor = new THREE.Color(s.color).lerp(new THREE.Color('#ffffff'), 0.4);
    }
  }
  return new THREE.MeshPhysicalMaterial(params);
}

/** What about a shape's look rebuilds its material (not its geometry). */
export const lookSignature = (b: Body3D) => JSON.stringify([b.materialType, b.color, b.surface]);
/** What about a shape's hair grows it again. */
export const hairSignature = (b: Body3D) => (b.hair ? JSON.stringify(b.hair) : '');

const furTexture = new Map<string, THREE.DataTexture>();
const furPatternOf = (seed: number) =>
  keep(furTexture, String(seed), () => {
    const t = new THREE.DataTexture(furPattern(seed), 128, 128, THREE.RGBAFormat);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.magFilter = THREE.NearestFilter;
    t.minFilter = THREE.NearestMipmapLinearFilter;
    t.generateMipmaps = true;
    t.needsUpdate = true;
    return t;
  });

/**
 * The hair grown on a shape, as an object to add beside its mesh: ribbons for strands, layers for fur. It is never picked
 * (a press goes through to the shape), and is grown in the shape's own space so it moves with it.
 */
export function hairObject(geometry: THREE.BufferGeometry, body: Body3D): THREE.Object3D | null {
  if (!body.hair) return null;
  const hair = settleHair(body.hair);
  const holder = new THREE.Group();
  holder.userData.hair = true;
  holder.raycast = () => {};
  if (hair.style === 'fur') {
    const layers = furLayers(geometry.getAttribute('position').count / 3);
    const pattern = furPatternOf(hair.seed);
    const root = new THREE.Color(hair.rootColor);
    const tip = new THREE.Color(hair.tipColor);
    let groom: GroomAt[] | undefined;
    for (let i = 1; i <= layers; i++) {
      const h = i / layers;
      const shell = furShell(geometry, hair, h, body.elevation ?? 0, groom);
      groom = shell.groom;
      const alpha = pattern.clone();
      alpha.repeat.set(furRepeat(hair), furRepeat(hair));
      alpha.needsUpdate = true;
      // Deeper in the coat is darker: light reaches the tips, not the roots.
      const color = root.clone().lerp(tip, h).multiplyScalar(0.55 + 0.45 * h);
      const material = new THREE.MeshStandardMaterial({ color, roughness: 1 - hair.shine * 0.4, metalness: 0, alphaMap: alpha, alphaTest: 0.08 + h * 0.85, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(shell.geometry, material);
      mesh.raycast = () => {};
      mesh.castShadow = i === 1;
      mesh.receiveShadow = true;
      holder.add(mesh);
    }
    return holder;
  }
  const strands = hairGeometry(geometry, hair, body.elevation ?? 0);
  if (!strands) return null;
  const material = new THREE.MeshPhysicalMaterial({
    vertexColors: true,
    roughness: 0.55 - hair.shine * 0.3,
    metalness: 0,
    // The highlight a hair has runs across it: an anisotropic sheen along its length (the tangent).
    anisotropy: 0.6 + hair.shine * 0.35,
    sheen: 0.3,
    sheenColor: new THREE.Color(hair.tipColor),
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(strands, material);
  mesh.raycast = () => {};
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  holder.add(mesh);
  return holder;
}

// ---- The surroundings ------------------------------------------------------------------------------

/** A sky dome with a sun, for the outdoor and night lights: a scene PMREM turns into reflections and light. */
function skyScene(top: string, horizon: string, ground: string, sun: string, sunAt: THREE.Vector3, sunSize: number, sunPower: number): THREE.Scene {
  const scene = new THREE.Scene();
  const geo = new THREE.SphereGeometry(100, 48, 24);
  const colors: number[] = [];
  const pos = geo.getAttribute('position');
  const t = new THREE.Color(top);
  const h = new THREE.Color(horizon);
  const g = new THREE.Color(ground);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) / 100;
    if (y >= 0) c.copy(h).lerp(t, Math.pow(y, 0.6));
    else c.copy(h).lerp(g, Math.min(1, -y * 4));
    colors.push(c.r, c.g, c.b);
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  scene.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })));
  const disc = new THREE.Mesh(new THREE.SphereGeometry(sunSize, 16, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(sun).multiplyScalar(sunPower) }));
  disc.position.copy(sunAt);
  scene.add(disc);
  return scene;
}

export interface Lighting {
  texture: THREE.Texture;
  intensity: number;
  /** The sun's colour, strength and direction for the light that casts shadows. */
  key: { color: string; intensity: number; position: [number, number, number] };
  exposure: number;
  /** Shown behind the model as well (outdoors); the studio keeps the window's own backdrop. */
  backdrop: boolean;
}

/** The light a scene's look gives. `pmrem` turns a scene into an environment map. */
export function lighting(look: SceneLook | undefined, pmrem: THREE.PMREMGenerator): Lighting {
  const env = look?.environment ?? 'studio';
  const exposure = 0.95 * (look?.exposure ?? 1);
  switch (env) {
    case 'daylight':
      return {
        texture: pmrem.fromScene(skyScene('#3d7ccf', '#cfe3f5', '#5b5a52', '#fff6e0', new THREE.Vector3(40, 70, 30), 5, 40), 0.02).texture,
        intensity: 0.7,
        key: { color: '#fff4dc', intensity: 1.6, position: [240, 480, 200] },
        exposure,
        backdrop: true,
      };
    case 'sunset':
      return {
        texture: pmrem.fromScene(skyScene('#27355f', '#f29a5c', '#3a2a25', '#ffb36b', new THREE.Vector3(80, 12, -40), 7, 30), 0.03).texture,
        intensity: 0.6,
        key: { color: '#ffb070', intensity: 1.5, position: [420, 120, -200] },
        exposure,
        backdrop: true,
      };
    case 'night':
      return {
        texture: pmrem.fromScene(skyScene('#05070f', '#1b2440', '#07080b', '#bcd0ff', new THREE.Vector3(-40, 60, 50), 3, 6), 0.03).texture,
        intensity: 0.35,
        key: { color: '#9fb6ff', intensity: 0.55, position: [-220, 420, 260] },
        exposure,
        backdrop: true,
      };
    default:
      return {
        texture: pmrem.fromScene(new RoomEnvironment(), 0.04).texture,
        intensity: 0.55,
        key: { color: '#ffffff', intensity: 1.15, position: [240, 420, 260] },
        exposure,
        backdrop: false,
      };
  }
}
