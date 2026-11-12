/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface Point2D {
  x: number;
  y: number;
}

export type MaterialType = 'matte' | 'metal' | 'glossy' | 'glass' | 'neon' | 'frosted' | 'velvet' | 'skin' | 'rubber';

/** A finish to start from: the numbers a shape's surface has until it sets its own (`Body3D.surface`). */
export interface MaterialPreset {
  id: MaterialType;
  name: string;
  color: string;
  roughness: number;
  metalness: number;
  emissiveIntensity?: number;
  transmission?: number;
  ior?: number;
  /** How far light travels into a see-through solid, mm. */
  thickness?: number;
  clearcoat?: number;
  /** The soft rim light of cloth and fuzz (velvet, felt, peach skin), 0 to 1. */
  sheen?: number;
  /** Light glowing through from under the surface (skin, wax, leaves, marble), 0 to 1. */
  subsurface?: number;
  opacity?: number;
}

/** A pattern drawn on a surface by the modeller itself (no image file needed). */
export type PatternKind = 'none' | 'wood' | 'marble' | 'noise' | 'weave' | 'scales' | 'checker' | 'brushed' | 'dots';

export interface SurfacePattern {
  kind: PatternKind;
  /** The pattern's second colour (the shape's colour is the first), #rrggbb. */
  color2: string;
  /** How big one repeat is, mm. */
  scale: number;
  /** How much it stands out from the surface as relief, 0 to 1. */
  bump: number;
  /** Turns the pattern on the surface, degrees. */
  angle?: number;
}

/** An image laid on a surface as its colour: a picture, a scan, a hand-painted texture. */
export interface SurfaceImage {
  /** The picture as a data URL (PNG or JPEG). */
  data: string;
  /** How big one repeat is, mm. Absent on a mesh that brought its own layout (UVs) from its file: it fits once. */
  scale?: number;
  name?: string;
  /** A relief picture only: how far its light parts stand out, 0 to 1. */
  strength?: number;
}

/** The pictures a surface can have: its colour, its relief (light stands out, dark sinks in) and its roughness (light is rough). */
export type PictureSlot = 'image' | 'reliefImage' | 'roughnessImage';
export const PICTURE_SLOTS: PictureSlot[] = ['image', 'reliefImage', 'roughnessImage'];

/**
 * A shape's own surface: every number a finish has, each overriding its preset (`materialType`) when set. A preset chosen
 * again clears these, so a preset is a place to start and these are the person's own choices on top of it.
 */
export interface Surface {
  roughness?: number;
  metalness?: number;
  /** 1 is solid, 0 is invisible. */
  opacity?: number;
  /** Clear like glass, 0 to 1. */
  transmission?: number;
  /** Index of refraction: 1.33 water, 1.5 glass, 2.4 diamond. */
  ior?: number;
  thickness?: number;
  clearcoat?: number;
  sheen?: number;
  sheenColor?: string;
  /** How brightly it glows in its own colour. */
  glow?: number;
  subsurface?: number;
  pattern?: SurfacePattern;
  image?: SurfaceImage;
  /** A grey picture of the surface's relief: light parts stand out, dark parts sink in (a bump map). */
  reliefImage?: SurfaceImage;
  /** A grey picture of where it is rough (light) and smooth (dark), times its roughness. */
  roughnessImage?: SurfaceImage;
}

/** One stroke of the person's grooming brush on a shape's hair, kept so the hair can be grown again with it. */
export interface GroomStroke {
  /** comb: lays the hair along the stroke; cut: shortens; lengthen: grows; puff: lifts it off the surface. */
  tool: 'comb' | 'cut' | 'lengthen' | 'puff';
  /** The path the brush took, `[x, y, height]` triples in mm in the shape's own numbers (as `MeshData`). */
  path: number[];
  radius: number;
  /** 0 to 1. */
  strength: number;
}

/**
 * Hair or fur growing from a shape's surface. The strands are not kept: they are grown from these numbers (and the
 * person's grooming strokes) whenever the shape is drawn, so the shape can still be moved, resized and sculpted.
 */
export interface Hair {
  /** strands: separate hairs that curl and clump (a head of hair, a mane); fur: a dense short coat (an animal, a rug). */
  style: 'strands' | 'fur';
  /** Hairs per square centimetre of surface. */
  density: number;
  /** mm. */
  length: number;
  /** Width of a hair at its root, mm. */
  thickness: number;
  /** 0 straight to 1 tight curls. */
  curl: number;
  /** Random wander along each hair, 0 to 1. */
  frizz: number;
  /** How much neighbouring hairs gather into locks, 0 to 1. */
  clump: number;
  /** How much the hair falls under its own weight, 0 stiff to 1 limp. */
  droop: number;
  rootColor: string;
  tipColor: string;
  /** The highlight band along the hair, 0 to 1. */
  shine: number;
  seed: number;
  strokes?: GroomStroke[];
}

/** How the whole scene is lit: the surroundings that glass, metal and hair reflect. */
export interface SceneLook {
  environment: 'studio' | 'daylight' | 'sunset' | 'night';
  /** Overall brightness, 0.3 to 2. */
  exposure: number;
}

export type BevelStyle = 'chamfer' | 'round';

/** A bevel on one top or bottom edge loop of a body. `edge` is a side index of the body's base outline. */
export interface EdgeBevel {
  side: 'top' | 'bottom';
  edge: number;
  size: number;
  style: BevelStyle;
}

/** A rounded or flat bevel on a vertical corner, cut so it follows any bevel on the edges above and below it. */
export interface CornerBevel {
  vertex: number;
  size: number;
  style: BevelStyle;
}

/**
 * Where a shape that stands on a wall sits in the world. Its outline, height and bevels are ordinary (as if it stood on the ground),
 * but its "ground" is the wall plane and its "up" points out of the wall. Shapes drawn on the ground or a top face have no frame.
 */
export interface Frame {
  /** The wall point the outline's origin sits on: plan position and height above the ground. */
  x: number;
  y: number;
  h: number;
  /** Direction the shape grows out of the wall, as an angle in plan (radians, counter-clockwise from +X). */
  angle: number;
}

/**
 * A triangle mesh brought in from a file (GLB, OBJ or STL): the shape's solid is this, not its outline pushed up. Positions are
 * `[x, y, height]` triples in millimetres: x, y on the ground (moved and turned with the shape's outline), height above the
 * shape's underside (so `elevation` lifts it). `points` of such a shape is the box its footprint fills.
 */
export interface MeshData {
  positions: number[];
  /** Three vertex numbers for each triangle, counter-clockwise seen from outside. */
  indices: number[];
  /** Where each vertex sits on the surface's image (u, v pairs), when the file had a layout. Ignored once its count no longer matches. */
  uvs?: number[];
}

export interface Body3D {
  id: string;
  name: string;
  /** Final outline as drawn (base outline with corner radii applied). Always derived; edit via withOutline(). */
  points: Point2D[];
  /** Sharp outline the user edits. Defaults to `points` when absent. */
  basePoints?: Point2D[];
  /** Radius of the vertical edge at each base vertex, in mm (0 = sharp). */
  cornerRadii?: number[];
  holes?: Point2D[][];
  /** Sharp outlines of the holes, and the corner radius at each of their vertices, once a hole has been edited. `holes` is derived. */
  holeBases?: Point2D[][];
  holeRadii?: number[][];
  extrusionHeight: number;
  /** Height of the body's underside above the ground plane. */
  elevation?: number;
  /** Bevels on individual top/bottom edges. Nothing is beveled by default. */
  edgeBevels?: EdgeBevel[];
  cornerBevels?: CornerBevel[];
  /** Set on a shape brought in as a mesh: its outline, bevels and holes are not used; `extrusionHeight` is the mesh's height. */
  mesh?: MeshData;
  color: string;
  materialType: MaterialType;
  /** The shape's own surface on top of its preset: see Surface. */
  surface?: Surface;
  /** Hair or fur growing from it: see Hair. */
  hair?: Hair;
  visible: boolean;
  createdAt: string;
  groupId?: string;
  /** Set on a shape drawn on a wall: see Frame. Absent for everything standing upright. */
  frame?: Frame;
  /** Set on a derived copy made by a live repeat: the id of the shape it follows. Never edited directly. */
  repeatOf?: string;
  /** Set on a shape that belongs to a linked library object: the id of that placed object (a group). Derived from the library, rebuilt on every change. */
  instanceOf?: string;
}

/** A selectable edge of a body: a top or bottom edge loop, or a vertical corner edge. */
/** A tapped face of a shape: its top or bottom, or one of its walls (`index` = base side). */
export interface FaceSel {
  bodyId: string;
  kind: 'top' | 'bottom' | 'wall';
  index?: number;
}

export interface EdgeSel {
  bodyId: string;
  kind: 'top' | 'bottom' | 'corner';
  /** Canonical side index for top/bottom, base vertex index for corner. Holes use `1000 * (hole + 1) + n` (see outline.ts). */
  index: number;
}

/** Where a placed library object sits: its footprint centre, its underside, and a turn (radians, counter-clockwise from above). */
export interface Placement {
  x: number;
  y: number;
  z: number;
  angle: number;
}

/**
 * A reusable object kept in the project: a snapshot of a group (or one shape), centred on the ground at the origin.
 * Placed copies follow it. `bodies[].groupId === ROOT` means directly inside the object.
 */
export interface LibraryItem {
  id: string;
  name: string;
  /** Also kept in the app-wide library, so every project can place it. */
  shared?: boolean;
  /** When it was last changed (ms). The newer copy wins when a project and the app-wide library disagree. */
  rev?: number;
  bodies: Body3D[];
  /** The groups inside the object (not the object itself); their parentId may be ROOT. */
  groups: ShapeGroup[];
}

export const ROOT = '@root';

export interface ShapeGroup {
  id: string;
  name: string;
  /** Every shape inside, at any depth. Derived: see utils/groups.ts. */
  bodyIds: string[];
  /** The group this one sits inside, when groups nest (a "head" inside a "character"). */
  parentId?: string;
  /** A placed library object: the item it follows. With `place` it is linked (its shapes are derived); without, it is open for editing. */
  libraryId?: string;
  place?: Placement;
  /** On the inner groups of a placed object: the placed object they belong to. Derived with the shapes. */
  instanceOf?: string;
  /** Made by Join or Subtract: the pieces form one solid, so it is presented as a single shape. */
  joined?: boolean;
}

/** An open Repeat: the shape being copied and the path its copies follow, edited live until Done. */
export interface RepeatSession {
  bodyId: string;
  /** `path`: along a line (bent by `bend`). `around`: round the circle centred on `end` that passes through `start`. */
  kind: 'path' | 'around';
  /** Centre of the original shape. */
  start: Point2D;
  /** End of the path, or the centre of the circle. */
  end: Point2D;
  /** Control point of the curve; null keeps the path straight. */
  bend: Point2D | null;
  /** Number of shapes including the original. */
  count: number;
  /** Turn each copy to face along the path. */
  follow: boolean;
  /** Set once the repeat is kept: it then lives in the document and its copies follow the source. */
  linkId?: string;
}

/** A kept repeat. The copies it makes are derived: they are rebuilt whenever the source or the path changes. */
export type RepeatLink = RepeatSession & { linkId: string };

/** What the Draw tool is making. */
export type DrawForm = 'shape' | 'rectangle' | 'circle';

/** An open Draw: an outline being sketched on the ground or on the top of a shape. */
export interface DrawSession {
  form: DrawForm;
  /** Height of the surface being drawn on; null until the first tap picks the ground or a top face. */
  planeY: number | null;
  /** Corners placed so far (`shape`). */
  points: Point2D[];
  /** `bends[i]`: a point the side from corner i to the next passes through, making it a curve. Null = straight. */
  bends: (Point2D | null)[];
  /** Drawing on a wall: the wall the sketch lies on. Absent on the ground or a top face. */
  frame?: Frame;
  /** Drawing on the top of this shape. */
  hostId?: string;
  /** Cut the sketch out of that shape (a hole straight through) instead of adding a new shape. */
  cut?: boolean;
}

export const MATERIAL_PRESETS: MaterialPreset[] = [
  {
    id: 'matte',
    name: 'Matte Polymer',
    color: '#3b82f6', // blue
    roughness: 0.8,
    metalness: 0.1
  },
  {
    id: 'metal',
    name: 'Anodized Steel',
    color: '#94a3b8', // slate/gray
    roughness: 0.2,
    metalness: 0.95
  },
  {
    id: 'glossy',
    name: 'Polished Lacquer',
    color: '#ef4444', // red
    roughness: 0.05,
    metalness: 0.0
  },
  {
    id: 'glass',
    name: 'Translucent Acrylic',
    color: '#10b981', // green
    roughness: 0.1,
    metalness: 0.0,
    transmission: 0.8,
    ior: 1.5
  },
  {
    id: 'neon',
    name: 'Emissive Lasing',
    color: '#eab308', // yellow
    roughness: 0.5,
    metalness: 0.0,
    emissiveIntensity: 1.5
  },
  {
    id: 'frosted',
    name: 'Frosted Glass',
    color: '#dbeafe',
    roughness: 0.45,
    metalness: 0.0,
    transmission: 0.9,
    ior: 1.5,
    thickness: 10
  },
  {
    id: 'velvet',
    name: 'Velvet Cloth',
    color: '#7c3aed',
    roughness: 0.9,
    metalness: 0.0,
    sheen: 1
  },
  {
    id: 'skin',
    name: 'Soft Skin',
    color: '#e0a98a',
    roughness: 0.55,
    metalness: 0.0,
    subsurface: 0.6,
    sheen: 0.2
  },
  {
    id: 'rubber',
    name: 'Rubber',
    color: '#1f2937',
    roughness: 0.95,
    metalness: 0.0
  }
];

export const GRID_SPACING = 20; // grid snap interval in pixels

export interface ColorSwatch {
  name: string;
  value: string;
}

export const SWATCHES: ColorSwatch[] = [
  { name: 'Cobalt Blue', value: '#3b82f6' },
  { name: 'Lead Gray', value: '#475569' },
  { name: 'Crimson Red', value: '#ef4444' },
  { name: 'Teal Forest', value: '#0d9488' },
  { name: 'Neon Amber', value: '#f59e0b' },
  { name: 'Emerald', value: '#10b981' },
  { name: 'Hot Pink', value: '#db2777' },
  { name: 'Brass Gold', value: '#b45309' },
  { name: 'Royal Violet', value: '#6d28d9' },
  { name: 'Snow Pearl', value: '#f1f5f9' },
];

