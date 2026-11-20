/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Body plans: a well-proportioned blockout of a figure from a few numbers, as an artist starts one. A biped is measured in
// head heights, a four-legged animal, a bird and a fish in their own length, the way anatomy books measure them, so the
// figure is right before anyone adjusts it. Each plan is a list of named blend parts (the same parts sculpt_blend takes),
// given back so they can be changed one by one and the form made again. The figure faces the front (-y), stands on the
// ground (z 0) and is centred on x 0; its left side is +x.

export type Plan = 'biped' | 'quadruped' | 'bird' | 'fish';
export const PLANS: Plan[] = ['biped', 'quadruped', 'bird', 'fish'];
export type Style = 'realistic' | 'stylized' | 'chibi';
export const STYLES: Style[] = ['realistic', 'stylized', 'chibi'];

export type Ears = 'none' | 'round' | 'pointed' | 'long';
export type Snout = 'none' | 'short' | 'long';
export type Tail = 'none' | 'short' | 'long' | 'bushy';
export type Horns = 'none' | 'small' | 'long';

export interface FigureArgs {
  plan: Plan;
  /** Standing height (biped, bird) or nose-to-rump length (quadruped, fish), mm. */
  size?: number;
  style?: Style;
  /** Multipliers on the plan's own proportions, 0.4 to 2.5 (1 is the plan's). */
  head?: number;
  neck?: number;
  body?: number;
  girth?: number;
  legs?: number;
  arms?: number;
  tail?: number;
  wings?: number;
  ears?: Ears;
  snout?: Snout;
  tailKind?: Tail;
  horns?: Horns;
  eyes?: boolean;
}

interface V {
  x: number;
  y: number;
  z: number;
}

/** One part, as sculpt_blend takes it, with the name it goes by. */
export interface FigurePart {
  label: string;
  kind: 'sphere' | 'capsule' | 'ellipsoid' | 'box';
  at: V;
  to?: V;
  radius?: number;
  radius2?: number;
  radii?: V;
  round?: number;
  turn?: V;
  carve?: boolean;
  color?: string;
  smooth?: number;
}

export interface Figure {
  parts: FigurePart[];
  smooth: number;
  detail: number;
  /** Where the main landmarks are, for adjusting by number. */
  landmarks: string;
}

export class FigureError extends Error {}

const r2 = (n: number) => Math.round(n * 100) / 100;
const v = (x: number, y: number, z: number): V => ({ x: r2(x), y: r2(y), z: r2(z) });
const flipX = (p: V): V => ({ ...p, x: -p.x });
const EYE = '#141414';

/** A part for the figure's left side (+x) and its mirror on the right, named "left ..." and "right ...". */
function pair(label: string, part: Omit<FigurePart, 'label'>): FigurePart[] {
  const right: FigurePart = { ...part, label: `right ${label}`, at: flipX(part.at), ...(part.to ? { to: flipX(part.to) } : {}) };
  // Mirroring across x keeps a turn about x and reverses the turns about y and z.
  if (part.turn) right.turn = v(part.turn.x, -part.turn.y, -part.turn.z);
  return [{ ...part, label: `left ${label}` }, right];
}

const cap = (label: string, at: V, to: V, radius: number, radius2 = radius, extra: Partial<FigurePart> = {}): Omit<FigurePart, 'label'> & { label: string } =>
  ({ label, kind: 'capsule', at, to, radius: r2(radius), radius2: r2(radius2), ...extra });
const ell = (label: string, at: V, rx: number, ry: number, rz: number, extra: Partial<FigurePart> = {}) =>
  ({ label, kind: 'ellipsoid' as const, at, radii: v(rx, ry, rz), ...extra });
const sph = (label: string, at: V, radius: number, extra: Partial<FigurePart> = {}) => ({ label, kind: 'sphere' as const, at, radius: r2(radius), ...extra });
const one = (p: FigurePart) => [p];
const both = (p: FigurePart) => pair(p.label, p);

const mul = (n: number | undefined, what: string) => {
  if (n === undefined) return 1;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0.4 || n > 2.5) throw new FigureError(`${what} must be a number from 0.4 to 2.5 (1 is the plan's own proportion).`);
  return n;
};

/** Ears on a head centred at `h` with half-sizes (hx, hy, hz). */
function earsOn(kind: Ears, h: V, hx: number, hy: number, hz: number, unit: number): FigurePart[] {
  if (kind === 'none') return [];
  if (kind === 'round') return both(sph('ear', v(h.x + hx * 0.95, h.y + hy * 0.15, h.z + hz * 0.15), unit * 0.22, { smooth: unit * 0.08 }));
  const tall = kind === 'long' ? 1.9 : 0.9;
  const base = v(h.x + hx * 0.55, h.y + hy * 0.2, h.z + hz * 0.75);
  return both(cap('ear', base, v(base.x + hx * 0.25, base.y + hy * 0.1, base.z + unit * tall), unit * 0.22, unit * (kind === 'long' ? 0.12 : 0.04), { smooth: unit * 0.1 }));
}

function hornsOn(kind: Horns, h: V, hx: number, hy: number, hz: number, unit: number): FigurePart[] {
  if (kind === 'none') return [];
  const long = kind === 'long';
  const base = v(h.x + hx * 0.4, h.y - hy * 0.1, h.z + hz * 0.85);
  return both(cap('horn', base, v(base.x + unit * (long ? 0.6 : 0.15), base.y + unit * (long ? 0.5 : 0.05), base.z + unit * (long ? 1.1 : 0.55)), unit * 0.16, unit * 0.02, { smooth: unit * 0.05, color: '#e8dcc0' }));
}

/** Eyes on the front of a head: dark spheres set into the surface. */
function eyesOn(on: boolean, h: V, hx: number, hy: number, hz: number, r: number, spread = 0.42, up = 0.12): FigurePart[] {
  if (!on) return [];
  // On the ellipsoid's front surface at that spread and height, sunk in a little.
  const x = hx * spread;
  const z = hz * up;
  const y = -hy * Math.sqrt(Math.max(0.05, 1 - (x / hx) ** 2 - (z / hz) ** 2)) + r * 0.45;
  return both(sph('eye', v(h.x + x, h.y + y, h.z + z), r, { color: EYE, smooth: r * 0.15 }));
}

function biped(a: FigureArgs): Figure {
  const H = a.size ?? 180;
  const style = a.style ?? 'realistic';
  const heads = { realistic: 7.5, stylized: 5.5, chibi: 3 }[style];
  const head = mul(a.head, 'head');
  const g = mul(a.girth, 'girth');
  const legs = mul(a.legs, 'legs');
  const arms = mul(a.arms, 'arms');
  const neckM = mul(a.neck, 'neck');
  const bodyM = mul(a.body, 'body');
  // Head height h; below the chin is the body B. A bigger head takes its height from the body, so the total stays H.
  const h = Math.min(H * 0.5, (H / heads) * head);
  const B = H - h;
  const chin = B;
  const neckGap = 0.35 * (H / heads) * neckM;
  const thick = 1 + (7.5 - heads) * 0.09; // stylised figures have stockier limbs for their size
  const shoulderZ = chin - neckGap;
  const hipZ = Math.min(shoulderZ - 0.2 * B, 0.577 * B * legs * (style === 'chibi' ? 0.85 : 1) / Math.max(0.6, bodyM * 0.5 + 0.5));
  const kneeZ = hipZ * 0.56;
  const ankleZ = Math.max(0.03 * B, hipZ * 0.08);
  const sw = 0.138 * B * g * (style === 'chibi' ? 0.85 : 1); // shoulder half-width
  const hw = 0.104 * B * g; // hip half-width
  const depth = 0.063 * B * g; // chest half-depth
  const torso = shoulderZ - hipZ;
  const limb = 0.05 * B * thick * Math.sqrt(g);

  const parts: FigurePart[] = [
    ...one(ell('pelvis', v(0, 0, hipZ + torso * 0.05), hw, depth * 0.95, torso * 0.2)),
    ...one(ell('belly', v(0, -depth * 0.05, hipZ + torso * 0.38), hw * 0.85, depth * 0.92, torso * 0.26)),
    ...one(ell('chest', v(0, -depth * 0.05, shoulderZ - torso * 0.27), sw * 0.82, depth * 1.05, torso * 0.3)),
    ...one(cap('neck', v(0, 0, shoulderZ - torso * 0.05), v(0, -h * 0.03, chin + h * 0.12), h * 0.17 * Math.sqrt(g), h * 0.15 * Math.sqrt(g))),
  ];
  const headC = v(0, -h * 0.04, chin + h * 0.5);
  const hx = h * (style === 'realistic' ? 0.36 : 0.44);
  const hy = h * (style === 'realistic' ? 0.42 : 0.46);
  const hz = h * 0.5;
  parts.push(...one(ell('head', headC, hx, hy, hz)));
  if ((a.snout ?? 'none') !== 'none') {
    const len = a.snout === 'long' ? h * 0.5 : h * 0.25;
    parts.push(...one(cap('snout', v(0, headC.y - hy * 0.6, headC.z - hz * 0.25), v(0, headC.y - hy * 0.6 - len, headC.z - hz * 0.35), h * 0.2, h * 0.14)));
  } else if (style === 'realistic') {
    parts.push(...one(ell('nose', v(0, headC.y - hy * 0.98, headC.z - hz * 0.05), h * 0.04, h * 0.05, h * 0.08, { smooth: h * 0.04 })));
  }
  parts.push(...earsOn(a.ears ?? 'round', headC, hx, hy, hz, h * (style === 'realistic' ? 0.45 : 0.6)));
  parts.push(...hornsOn(a.horns ?? 'none', headC, hx, hy, hz, h * 0.5));
  parts.push(...eyesOn(a.eyes ?? true, headC, hx, hy, hz, h * (style === 'chibi' ? 0.1 : style === 'stylized' ? 0.075 : 0.05), 0.4, style === 'chibi' ? -0.05 : 0.05));

  // Arms hang down and a little out (an A pose: easy to rig and to pose later).
  const shoulder = v(sw * 0.92, 0, shoulderZ - limb * 0.5);
  const upper = 0.196 * B * arms;
  const fore = 0.17 * B * arms;
  const out = Math.sin((14 * Math.PI) / 180);
  const down = Math.cos((14 * Math.PI) / 180);
  const elbow = v(shoulder.x + upper * out, shoulder.y + upper * 0.05, shoulder.z - upper * down);
  const wrist = v(elbow.x + fore * out * 0.8, elbow.y - fore * 0.12, elbow.z - fore * down);
  const hand = 0.12 * B * arms;
  parts.push(
    ...both(sph('shoulder', shoulder, limb * 0.95)),
    ...both(cap('upper arm', shoulder, elbow, limb * 0.72, limb * 0.55)),
    ...both(cap('forearm', elbow, wrist, limb * 0.55, limb * 0.4)),
    ...both(ell('hand', v(wrist.x + hand * 0.18, wrist.y, wrist.z - hand * 0.45), limb * 0.3, limb * 0.6, hand * 0.5, { turn: v(0, -20, 0) })),
  );
  // Legs: thigh, shin, foot pointing forward.
  const hip = v(hw * 0.55, 0, hipZ);
  const knee = v(hw * 0.5, -depth * 0.1, kneeZ);
  const ankle = v(hw * 0.48, depth * 0.1, ankleZ);
  const foot = 0.17 * B * (style === 'chibi' ? 0.9 : 1);
  parts.push(
    ...both(cap('thigh', hip, knee, limb * 1.15, limb * 0.75)),
    ...both(cap('shin', knee, ankle, limb * 0.75, limb * 0.45)),
    ...both({ label: 'foot', kind: 'box', at: v(ankle.x, ankle.y - foot * 0.3, ankleZ * 0.55), radii: v(limb * 0.55, foot * 0.5, Math.max(ankleZ * 0.55, limb * 0.3)), round: Math.max(ankleZ * 0.5, limb * 0.28) }),
  );
  if ((a.tailKind ?? 'none') !== 'none') parts.push(...tailFrom(a.tailKind!, v(0, depth * 0.9, hipZ + torso * 0.05), H * 0.35 * mul(a.tail, 'tail'), limb * 0.6, 1));
  return {
    parts,
    smooth: r2(limb * 0.55),
    detail: 128,
    landmarks: `${r2(H / h)} heads tall. Head top z ${r2(H)}, chin ${r2(chin)}, shoulders ${r2(shoulderZ)} (half-width ${r2(sw)}), hips ${r2(hipZ)} (half-width ${r2(hw)}), knees ${r2(kneeZ)}, ankles ${r2(ankleZ)}; elbows ${r2(elbow.z)}, wrists ${r2(wrist.z)}.`,
  };
}

/** A tail from `root` going back (+y) and up, as one capsule, or a few for a long or bushy one. */
function tailFrom(kind: Tail, root: V, length: number, radius: number, rise: number): FigurePart[] {
  if (kind === 'none') return [];
  if (kind === 'short') return [cap('tail', root, v(0, root.y + length * 0.35, root.z + length * 0.25 * rise), radius, radius * 0.4) as FigurePart];
  const bushy = kind === 'bushy';
  const mid = v(0, root.y + length * 0.5, root.z + length * 0.35 * rise);
  const tip = v(0, root.y + length * 0.85, root.z + length * 0.75 * rise);
  return [
    cap('tail base', root, mid, radius * (bushy ? 1.3 : 1), radius * (bushy ? 1.8 : 0.7)) as FigurePart,
    cap('tail tip', mid, tip, radius * (bushy ? 1.8 : 0.7), radius * (bushy ? 0.9 : 0.25)) as FigurePart,
  ];
}

function quadruped(a: FigureArgs): Figure {
  const L = a.size ?? 300;
  const style = a.style ?? 'realistic';
  const g = mul(a.girth, 'girth') * (style === 'chibi' ? 1.25 : 1);
  const legs = mul(a.legs, 'legs') * (style === 'chibi' ? 0.7 : 1);
  const head = mul(a.head, 'head') * (style === 'chibi' ? 1.6 : style === 'stylized' ? 1.2 : 1);
  const neckM = mul(a.neck, 'neck');
  const bodyM = mul(a.body, 'body');
  // The trunk, shoulder to rump, is the measure: legs as long as the trunk is deep times a bit, like a dog.
  const trunk = 0.62 * L * bodyM;
  const half = trunk / 2;
  const belly = 0.36 * L * legs; // ground to the underside of the chest
  const bz = belly + 0.13 * L * g; // the trunk's centre line
  const chestY = -half * 0.65;
  const rumpY = half * 0.7;
  const limb = 0.045 * L * Math.sqrt(g);
  const parts: FigurePart[] = [
    ...one(ell('chest', v(0, chestY, bz + 0.01 * L), 0.12 * L * g, 0.17 * L, 0.15 * L * g)),
    ...one(ell('barrel', v(0, 0, bz), 0.11 * L * g, half * 0.7, 0.13 * L * g)),
    ...one(ell('hips', v(0, rumpY, bz + 0.015 * L), 0.105 * L * g, 0.14 * L, 0.13 * L * g)),
  ];
  // The neck rises forward from the chest; the head sits at its end, the muzzle pointing forward.
  const neckBase = v(0, chestY - 0.08 * L, bz + 0.06 * L);
  const neckLen = 0.2 * L * neckM;
  const headC = v(0, neckBase.y - neckLen * 0.6, neckBase.z + neckLen * 0.8);
  const hx = 0.075 * L * head;
  const hy = 0.09 * L * head;
  const hz = 0.075 * L * head;
  parts.push(...one(cap('neck', neckBase, headC, 0.075 * L * Math.sqrt(g), 0.055 * L * Math.sqrt(head))));
  parts.push(...one(ell('head', headC, hx, hy, hz)));
  const snout = a.snout ?? 'short';
  if (snout !== 'none') {
    const len = (snout === 'long' ? 0.16 : 0.08) * L * Math.sqrt(head);
    parts.push(...one(cap('muzzle', v(0, headC.y - hy * 0.55, headC.z - hz * 0.25), v(0, headC.y - hy * 0.55 - len, headC.z - hz * 0.4), hz * 0.55, hz * 0.42)));
    parts.push(...one(sph('nose', v(0, headC.y - hy * 0.55 - len - hz * 0.35, headC.z - hz * 0.35), hz * 0.2, { color: EYE, smooth: hz * 0.08 })));
  }
  parts.push(...earsOn(a.ears ?? 'pointed', headC, hx, hy, hz, hz * 0.9));
  parts.push(...hornsOn(a.horns ?? 'none', headC, hx, hy, hz, hz * 1.2));
  parts.push(...eyesOn(a.eyes ?? true, headC, hx, hy, hz, hz * (style === 'chibi' ? 0.22 : 0.13), 0.5, 0.2));
  // Front legs: shoulder, elbow, wrist, paw, nearly straight.
  const fx = 0.07 * L * g;
  const fShoulder = v(fx, chestY + 0.02 * L, bz);
  const elbow = v(fx, chestY + 0.03 * L, belly * 0.62);
  const wrist = v(fx, chestY - 0.005 * L, belly * 0.14);
  // Hind legs fold the other way: hip, stifle (forward), hock (back), paw.
  const hShoulder = v(fx * 0.95, rumpY + 0.02 * L, bz);
  const stifle = v(fx, rumpY - 0.04 * L, belly * 0.6);
  const hock = v(fx, rumpY + 0.06 * L, belly * 0.25);
  const hPaw = v(fx, rumpY + 0.03 * L, belly * 0.06);
  const paw = Math.max(limb * 0.7, belly * 0.07);
  parts.push(
    ...both(cap('upper foreleg', fShoulder, elbow, limb * 1.3, limb * 0.8)),
    ...both(cap('lower foreleg', elbow, wrist, limb * 0.8, limb * 0.55)),
    ...both(ell('front paw', v(fx, wrist.y - paw * 0.5, paw * 0.7), limb * 0.75, paw * 1.2, paw * 0.7)),
    ...both(cap('thigh', hShoulder, stifle, limb * 1.6, limb * 0.9)),
    ...both(cap('hind shank', stifle, hock, limb * 0.9, limb * 0.6)),
    ...both(cap('hind foot', hock, hPaw, limb * 0.6, limb * 0.55)),
    ...both(ell('hind paw', v(fx, hPaw.y - paw * 0.5, paw * 0.7), limb * 0.75, paw * 1.2, paw * 0.7)),
  );
  parts.push(...tailFrom(a.tailKind ?? 'long', v(0, rumpY + 0.12 * L, bz + 0.05 * L), 0.5 * L * mul(a.tail, 'tail'), limb * 0.7, 0.6));
  return {
    parts,
    smooth: r2(limb * 0.7),
    detail: 128,
    landmarks: `Faces -y. Nose at y ${r2(headC.y - hy - (snout === 'long' ? 0.16 : snout === 'short' ? 0.08 : 0) * L)}, chest y ${r2(chestY)}, rump y ${r2(rumpY)}; back z ${r2(bz + 0.13 * L * g)}, belly z ${r2(belly)}, head centre z ${r2(headC.z)}; legs at x ±${r2(fx)}.`,
  };
}

function bird(a: FigureArgs): Figure {
  const H = a.size ?? 150;
  const style = a.style ?? 'realistic';
  const g = mul(a.girth, 'girth') * (style === 'chibi' ? 1.2 : 1);
  const legs = mul(a.legs, 'legs');
  const head = mul(a.head, 'head') * (style === 'chibi' ? 1.5 : style === 'stylized' ? 1.2 : 1);
  const wings = mul(a.wings, 'wings');
  const neckM = mul(a.neck, 'neck');
  const legH = 0.25 * H * legs;
  const bodyC = v(0, 0.02 * H, legH + 0.2 * H * g);
  const parts: FigurePart[] = [
    ...one(ell('body', bodyC, 0.17 * H * g, 0.27 * H * mul(a.body, 'body'), 0.19 * H * g, { turn: v(-25, 0, 0) })),
    ...one(ell('breast', v(0, bodyC.y - 0.12 * H, bodyC.z + 0.02 * H), 0.15 * H * g, 0.14 * H, 0.16 * H * g)),
  ];
  const headC = v(0, bodyC.y - 0.17 * H, bodyC.z + 0.27 * H * neckM);
  const r = 0.11 * H * head;
  parts.push(...one(cap('neck', v(0, bodyC.y - 0.12 * H, bodyC.z + 0.08 * H), headC, 0.09 * H * g, r * 0.75)));
  parts.push(...one(ell('head', headC, r * 0.9, r, r)));
  const beak = (a.snout ?? 'short') === 'long' ? 0.24 * H : 0.11 * H;
  if ((a.snout ?? 'short') !== 'none') parts.push(...one(cap('beak', v(0, headC.y - r * 0.8, headC.z - r * 0.1), v(0, headC.y - r * 0.8 - beak, headC.z - r * 0.3), r * 0.35, r * 0.04, { color: '#e0a030', smooth: r * 0.1 })));
  parts.push(...eyesOn(a.eyes ?? true, headC, r * 0.9, r, r, r * (style === 'chibi' ? 0.25 : 0.16), 0.62, 0.2));
  // Folded wings lie along the body's sides, tips toward the tail.
  const span = 0.3 * H * wings;
  parts.push(...both(ell('wing', v(0.16 * H * g, bodyC.y + 0.06 * H, bodyC.z + 0.02 * H), 0.035 * H, span, 0.13 * H * Math.sqrt(wings), { turn: v(-28, 0, -6), smooth: 0.02 * H })));
  parts.push(...one(ell('tail', v(0, bodyC.y + 0.33 * H * mul(a.tail, 'tail'), bodyC.z - 0.08 * H), 0.09 * H, 0.14 * H * mul(a.tail, 'tail'), 0.025 * H, { turn: v(-30, 0, 0) })));
  // Legs: thin shanks to the ground, three toes forward and one back.
  const hip = v(0.06 * H, bodyC.y, legH + 0.04 * H);
  const ankle = v(0.06 * H, bodyC.y + 0.01 * H, 0.025 * H);
  const leg = 0.022 * H;
  const toe = 0.09 * H;
  parts.push(
    ...both(cap('leg', hip, ankle, leg * 1.4, leg, { color: '#e0a030' })),
    ...both(cap('front toe', ankle, v(ankle.x, ankle.y - toe, leg * 0.9), leg * 0.8, leg * 0.6, { color: '#e0a030' })),
    ...both(cap('outer toe', ankle, v(ankle.x + toe * 0.6, ankle.y - toe * 0.75, leg * 0.9), leg * 0.75, leg * 0.55, { color: '#e0a030' })),
    ...both(cap('back toe', ankle, v(ankle.x, ankle.y + toe * 0.55, leg * 0.9), leg * 0.7, leg * 0.5, { color: '#e0a030' })),
  );
  return {
    parts,
    smooth: r2(0.03 * H),
    detail: 128,
    landmarks: `Faces -y. Head centre z ${r2(headC.z)} (radius ${r2(r)}), body centre z ${r2(bodyC.z)}, legs from z ${r2(hip.z)} to the ground at x ±${r2(hip.x)}; wings along the sides at x ±${r2(0.16 * H * g)}.`,
  };
}

function fish(a: FigureArgs): Figure {
  const L = a.size ?? 300;
  const style = a.style ?? 'realistic';
  const g = mul(a.girth, 'girth') * (style === 'chibi' ? 1.3 : 1);
  const tail = mul(a.tail, 'tail');
  const deep = 0.17 * L * g;
  const c = v(0, 0, deep + 0.02 * L);
  const fin = 0.012 * L;
  const parts: FigurePart[] = [
    ...one(ell('body', c, 0.09 * L * g, 0.3 * L * mul(a.body, 'body'), deep)),
    ...one(ell('head', v(0, c.y - 0.2 * L, c.z - deep * 0.05), 0.085 * L * g * mul(a.head, 'head'), 0.15 * L * mul(a.head, 'head'), deep * 0.85)),
    ...one(cap('tail stalk', v(0, c.y + 0.22 * L, c.z), v(0, c.y + 0.4 * L, c.z), deep * 0.55, deep * 0.2)),
    ...one(ell('upper tail fin', v(0, c.y + 0.46 * L * tail, c.z + deep * 0.5 * tail), fin, 0.07 * L * tail, 0.16 * L * tail, { turn: v(-35, 0, 0), smooth: fin })),
    ...one(ell('lower tail fin', v(0, c.y + 0.46 * L * tail, c.z - deep * 0.5 * tail), fin, 0.07 * L * tail, 0.16 * L * tail, { turn: v(35, 0, 0), smooth: fin })),
    ...one(ell('dorsal fin', v(0, c.y + 0.02 * L, c.z + deep * 1.05), fin, 0.13 * L, 0.07 * L, { turn: v(-25, 0, 0), smooth: fin })),
    ...both(ell('side fin', v(0.08 * L * g, c.y - 0.12 * L, c.z - deep * 0.45), 0.06 * L, 0.05 * L, fin, { turn: v(0, 25, -20), smooth: fin })),
    ...one({ label: 'mouth', kind: 'ellipsoid', at: v(0, c.y - 0.35 * L, c.z - deep * 0.2), radii: v(0.03 * L, 0.03 * L, 0.012 * L), carve: true, smooth: fin }),
  ];
  const headC = v(0, c.y - 0.2 * L, c.z - deep * 0.05);
  parts.push(...eyesOn(a.eyes ?? true, headC, 0.085 * L * g, 0.15 * L, deep * 0.85, 0.022 * L * (style === 'chibi' ? 1.8 : 1), 0.75, 0.2).map((p) => ({ ...p, at: v(p.at.x, headC.y - 0.06 * L, p.at.z) })));
  return {
    parts,
    smooth: r2(0.02 * L),
    detail: 128,
    landmarks: `Faces -y. Mouth at y ${r2(c.y - 0.35 * L)}, tail fin at y ${r2(c.y + 0.46 * L * tail)}; centre line z ${r2(c.z)}, belly z ${r2(c.z - deep)}, back z ${r2(c.z + deep)}.`,
  };
}

/** A figure's blockout: the named parts and the blend settings to make it with. */
export function figure(a: FigureArgs): Figure {
  if (!PLANS.includes(a.plan)) throw new FigureError(`plan must be one of ${PLANS.join(', ')}.`);
  if (a.style !== undefined && !STYLES.includes(a.style)) throw new FigureError(`style must be one of ${STYLES.join(', ')}.`);
  if (a.size !== undefined && !(typeof a.size === 'number' && a.size >= 5 && a.size <= 5000)) throw new FigureError('size must be from 5 to 5000 mm.');
  const made = { biped, quadruped, bird, fish }[a.plan](a);
  const at = (p: V) => [p.x, p.y, p.z].every(Number.isFinite);
  if (!made.parts.every((p) => at(p.at) && (!p.to || at(p.to)))) throw new FigureError('Those proportions do not make a figure: bring the numbers nearer 1.');
  return made;
}
