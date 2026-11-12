/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Body3D, MATERIAL_PRESETS } from '../types';
import { PATTERN_KINDS } from '../utils/surface';
import { Doc, IdGen } from './doc';
import { fail } from './errors';
import { AgentError } from './errors';
import { thumbnailSvg } from '../utils/thumbnail';
import { describeEdgesOf, describeFaces, libraryItems, meshReport, sceneSummary, summarize } from './inspect';
import * as ops from './ops';

/** A JSON-Schema-described command an agent can call. These specs are what MCP and LLM tool-use want. */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** True when it only reads: it never changes the model. */
  readOnly?: boolean;
  /** True when only the live app can do it (it needs a screen). */
  uiOnly?: boolean;
  /** Who may make this command: `agent` (the default) or `person`, the person's own hand, which the agent is never given. */
  authority?: 'agent' | 'person';
}

const point = { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'], description: 'A point on the ground plane, mm.' };
const point3 = { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number', description: 'Height above the ground (default 0).' } }, required: ['x', 'y'], description: 'A point in the model, mm: x, y on the ground and z up.' };
const ids = { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Shape ids.' };
const face = {
  description: 'A face: "top", "bottom", or {"kind":"wall","index":n}. shape_faces lists them with their indices.',
  oneOf: [{ type: 'string', enum: ['top', 'bottom'] }, { type: 'object', properties: { kind: { const: 'wall' }, index: { type: 'integer' } }, required: ['kind', 'index'] }],
};
const surface = {
  description:
    'Where to draw. "ground" (default); {"topOf": id} the top face of a shape; {"z": mm} a horizontal plane at a height; or {"wallOf": id, "wall": index, "along"?: mm, "up"?: mm} one of its walls (the sketch then lies in the wall: x runs to the right as you face it, y runs up, both from the middle of the wall; "along"/"up" shift that origin).',
  oneOf: [
    { type: 'string', enum: ['ground'] },
    { type: 'object', properties: { topOf: { type: 'string' } }, required: ['topOf'] },
    { type: 'object', properties: { z: { type: 'number' } }, required: ['z'] },
    { type: 'object', properties: { wallOf: { type: 'string' }, wall: { type: 'integer' }, along: { type: 'number' }, up: { type: 'number' } }, required: ['wallOf', 'wall'] },
  ],
};
const sketch = {
  form: { type: 'string', enum: ['polygon', 'rectangle', 'circle'] },
  points: { type: 'array', items: point, minItems: 3, description: 'polygon: the corners in order.' },
  bends: { type: 'array', items: { oneOf: [point, { type: 'null' }] }, description: 'polygon: for each side (corner i to corner i+1, the last closes the shape) a point the side passes through, making it a curve; null keeps it straight.' },
  from: { ...point, description: 'rectangle: one corner.' },
  to: { ...point, description: 'rectangle: the opposite corner.' },
  center: { ...point, description: 'circle: its centre.' },
  radius: { type: 'number', description: 'circle: radius, mm.' },
};
const material = { type: 'string', enum: MATERIAL_PRESETS.map((p) => p.id), description: 'A finish to start from: matte, metal, glossy, glass, neon, frosted (frosted glass), velvet (cloth with a soft sheen), skin (soft, light glows through) or rubber. surface_set fine-tunes it.' };
const unit = (what: string) => ({ type: 'number', minimum: 0, maximum: 1, description: what });
const color = { type: 'string', description: 'Hex colour such as "#3b82f6".' };

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: 'scene_get',
    description:
      'List every shape in the model with its id, name, size, position, material, bevels, group and repeat, plus groups and the overall bounding box. Start here. Axes: x to the right, y away from the front, z up; all in millimetres. A shape stands on its "bottom" z and rises to its "top".',
    inputSchema: obj({ includeCopies: { type: 'boolean', description: 'Also list the copies a live repeat makes (hidden by default; they follow their source).' } }),
    readOnly: true,
  },
  { name: 'shape_get', description: 'Everything about one shape: its summary, raw outline, faces and edges.', inputSchema: obj({ id: { type: 'string' } }, ['id']), readOnly: true },
  { name: 'shape_faces', description: 'The faces of a shape (top, bottom, each wall) with how to name them in commands, which way each wall faces, and its measurement.', inputSchema: obj({ id: { type: 'string' } }, ['id']), readOnly: true },
  { name: 'shape_edges', description: 'The bevel-able edges of a shape (top/bottom rims by index, vertical corners), with their length and any bevel.', inputSchema: obj({ id: { type: 'string' } }, ['id']), readOnly: true },
  {
    name: 'shape_measure',
    description: 'Build the real solid (bevels and all) and report its volume (mm³), surface area, triangle count and whether it is watertight (printable). Slower than the others.',
    inputSchema: obj({ id: { type: 'string' } }, ['id']),
    readOnly: true,
  },
  {
    name: 'shape_add',
    description:
      'Add a stock shape: box, roundedBox, cylinder, triangle, wedge, pentagon, hexagon, octagon or star. It is centred at x,y (default: beside the existing shapes), stands on elevation (default 0, the ground) and rises height mm. With onTopOf it sits on top of that shape.',
    inputSchema: obj(
      {
        kind: { type: 'string', enum: ['box', 'roundedBox', 'cylinder', 'triangle', 'wedge', 'pentagon', 'hexagon', 'octagon', 'star'] },
        x: { type: 'number' },
        y: { type: 'number' },
        width: { type: 'number', description: 'Size along x, mm (default 60).' },
        depth: { type: 'number', description: 'Size along y, mm (default: same as width for round and regular shapes, else 60).' },
        height: { type: 'number', description: 'Default 40.' },
        elevation: { type: 'number', description: 'Height of its underside above the ground.' },
        onTopOf: { type: 'string', description: 'Id of a shape to sit on.' },
        name: { type: 'string' },
        color,
        material,
      },
      ['kind']
    ),
  },
  {
    name: 'shape_draw',
    description:
      'Sketch an outline (polygon with optional curved sides, rectangle or circle) on a surface and extrude it into a new shape (default 20 mm). On a wall the shape grows out of the wall.',
    inputSchema: obj({ ...sketch, surface, height: { type: 'number', description: 'How far it extrudes, mm (default 20). On a wall: out from the wall.' }, name: { type: 'string' }, color, material }, ['form']),
  },
  {
    name: 'shape_cut',
    description:
      'Cut a hole or pocket into a shape: sketch an outline on its top face and cut it down by depth mm (or all the way through when depth is omitted). Upright shapes only.',
    inputSchema: obj({ target: { type: 'string' }, ...sketch, surface, depth: { type: 'number' } }, ['target', 'form']),
  },
  {
    name: 'shape_set',
    description:
      'Change a shape: name, colour, material, visibility, height, elevation (its underside), one radius for all vertical corners, or replace its outline with new corner points (this clears its holes and bevels).',
    inputSchema: obj(
      {
        id: { type: 'string' },
        name: { type: 'string' },
        color,
        material,
        visible: { type: 'boolean' },
        height: { type: 'number' },
        elevation: { type: 'number' },
        cornerRadius: { type: 'number' },
        outline: obj({ points: { type: 'array', items: point, minItems: 3 }, cornerRadii: { type: 'array', items: { type: 'number' } } }, ['points']),
      },
      ['id']
    ),
  },
  {
    name: 'shape_move',
    description: 'Move shapes (and their group-mates; a live repeat\'s path goes with its shape). Either by an offset, or to a place: footprint centre x,y and underside z.',
    inputSchema: obj(
      {
        ids,
        by: obj({ x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } }),
        to: obj({ x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } }),
      },
      ['ids']
    ),
  },
  {
    name: 'shape_turn',
    description: 'Turn shapes about the vertical axis. Positive degrees turn counter-clockwise seen from above. Default pivot: the centre of the shapes.',
    inputSchema: obj({ ids, degrees: { type: 'number' }, about: point }, ['ids', 'degrees']),
  },
  {
    name: 'mesh_import',
    description:
      'Bring in a triangle mesh from a file as ONE shape: .glb/.gltf, .obj or .stl (a free CC0 model from Poly Pizza, Quaternius or Sketchfab, or one made in Blender). It arrives as the real surface, so organic forms (an animal, a face, a scan) are possible, which stock shapes and extruded outlines cannot give. It stands on the ground; size sets its longest side in mm (without it a GLB is read in metres, STL and OBJ in mm, and a result that is a speck or a building is fitted to 100 mm). Very large meshes are simplified to 60000 triangles. Move, turn, resize (shape_resize scales it whole), recolour, group and export work on it; it has no outline, faces, bevels or holes, and cannot be joined or cut with the outline tools. A GLB\'s base colour picture (texture) comes with it when it is inside the file and every part has a layout (UVs); otherwise colour it with color, material or surface_set.',
    inputSchema: obj({
      file: { type: 'string', description: 'The mesh file: an artifact id (file_...) or a path on the host. The host reads it.' },
      format: { type: 'string', enum: ['glb', 'obj', 'stl'], description: 'Only if the file name does not say (glTF counts as glb).' },
      size: { type: 'number', description: 'The longest side of the result, mm.' },
      up: { type: 'string', enum: ['y', 'z'], description: 'Which axis is up in the file. Default: y for GLB and OBJ, z for STL. Use it when the model arrives lying down.' },
      x: { type: 'number' },
      y: { type: 'number' },
      elevation: { type: 'number', description: 'Height of its underside above the ground.' },
      name: { type: 'string' },
      color: color,
      material,
    }),
  },
  {
    name: 'sculpt_blend',
    description:
      'Make ONE smooth, organic shape by blending simple parts into a soft surface: the way to model an animal, a creature, a hand, a bottle, a cloud. Give parts: spheres, tapered capsules (a limb or neck: at, to, radius at each end) and ellipsoids (a body or head: radii along x, y, z). Where parts overlap they melt together over `smooth` mm. Positions are in mm on the ground (x, y) and up (z); parts may overlap and may sit anywhere. Give half of a symmetric creature and set mirror ({axis, at}) to reflect it. Build the big masses first (body, chest, hips, head), then limbs overlapping into them; look with scene_get / a view and adjust the numbers, or use sculpt_smooth. The result is a mesh shape: move, turn, resize, recolour and export work; it has no outline, faces or holes. A person can refine it by hand in the window.',
    inputSchema: obj(
      {
        parts: {
          type: 'array',
          description: 'The parts to blend (1 to 64; mirroring doubles them).',
          items: obj(
            {
              kind: { type: 'string', enum: ['sphere', 'capsule', 'ellipsoid'] },
              at: { ...point3, description: 'Sphere or ellipsoid centre, or a capsule\'s first end, mm.' },
              to: { ...point3, description: 'A capsule\'s other end.' },
              radius: { type: 'number', description: 'Sphere radius, or a capsule\'s radius at `at`.' },
              radius2: { type: 'number', description: 'A capsule\'s radius at `to` (default: the same).' },
              radii: { ...point3, description: 'An ellipsoid\'s half-sizes along x, y and z.' },
            },
            ['kind', 'at']
          ),
        },
        smooth: { type: 'number', description: 'How wide the soft joins are, mm. Default: 0.6 x the smallest part radius. 0 leaves creases.' },
        detail: { type: 'number', description: 'Fineness: grid cells along the longest side (8 to 120, default 72). Higher is smoother and slower.' },
        mirror: obj({ axis: { type: 'string', enum: ['x', 'y', 'z'] }, at: { type: 'number', description: 'Where the mirror plane is on that axis. Default: the middle of the parts.' } }, ['axis']),
        name: { type: 'string' },
        color: color,
        material,
      },
      ['parts']
    ),
  },
  {
    name: 'sculpt_loft',
    description:
      'Make ONE smooth tube along a path through cross-sections that change size: a leg, a neck, a tail, a horn, a tentacle, a vase. Each section is a centre (mm) and an elliptical size; the path is a smooth curve through the centres and the ends are closed. radius is the half-size in the first direction (up for a path that runs sideways; along x for one that runs up or down) and radius2 the other (default: the same, a round tube). Result is a mesh shape, like sculpt_blend.',
    inputSchema: obj(
      {
        sections: {
          type: 'array',
          description: 'Two to 48 sections in order along the path.',
          items: obj({ at: point3, radius: { type: 'number' }, radius2: { type: 'number' } }, ['at', 'radius']),
        },
        sides: { type: 'number', description: 'Points round each section (6 to 64, default 24).' },
        steps: { type: 'number', description: 'Extra smooth steps between sections (1 to 12, default 4).' },
        name: { type: 'string' },
        color: color,
        material,
      },
      ['sections']
    ),
  },
  {
    name: 'sculpt_smooth',
    description:
      'Smooth a mesh shape (from sculpt_blend, sculpt_loft or mesh_import): evens out lumps and stair-steps without shrinking it. subdivide splits every triangle in four first (0 to 2) so a coarse mesh has more to work with. A gentle pass or two; it softens detail, so do it before adding fine features.',
    inputSchema: obj(
      {
        id: { type: 'string' },
        passes: { type: 'number', description: 'Rounds of smoothing, 0 to 20 (default 2).' },
        strength: { type: 'number', description: '0 to 1, how far each round moves points (default 0.5).' },
        subdivide: { type: 'number', description: '0, 1 or 2 (default 0).' },
      },
      ['id']
    ),
  },
  {
    name: 'sculpt_apply',
    description: 'The person\'s brush stroke on a mesh shape: its surface points after the stroke. Not for the agent: shaping a form by hand is the person\'s.',
    inputSchema: obj({ id: { type: 'string' }, positions: { type: 'array', items: { type: 'number' }, description: 'Every surface point after the stroke, [x, y, height] triples in mm.' } }, ['id', 'positions']),
    authority: 'person',
  },
  {
    name: 'surface_set',
    description:
      'Change what shapes are made of, beyond the material presets: start from a preset (it clears earlier fine-tuning) and/or set any number of the finish, a pattern the modeller draws itself, or a picture laid on it. Glass: transmission 1, roughness 0 (clear) to 0.5 (frosted), ior 1.33 water / 1.5 glass / 2.4 diamond, thickness in mm. Cloth and fuzz: sheen. Skin, wax, leaves, marble: subsurface. Light: glow. A pattern is in the shape\'s colour and color2, repeating every scale mm, with bump for relief. A picture: image (an artifact id or path; the host reads it, PNG or JPEG), repeating every imageScale mm (a mesh whose file had a layout fits it once). Several shapes at once with ids.',
    inputSchema: obj({
      id: { type: 'string' },
      ids,
      preset: material,
      color,
      roughness: unit('0 mirror-smooth to 1 fully matte.'),
      metalness: unit('0 non-metal to 1 metal.'),
      opacity: { type: 'number', minimum: 0.05, maximum: 1, description: 'How solid it is: 1 solid, lower fades it out (not glass: use transmission).' },
      transmission: unit('How clear it is, like glass or water.'),
      ior: { type: 'number', minimum: 1, maximum: 2.5, description: 'How much a clear surface bends light.' },
      thickness: { type: 'number', minimum: 0, maximum: 200, description: 'How thick a clear or glowing-through solid is, mm: thicker tints and bends more.' },
      clearcoat: unit('A clear lacquer layer on top (car paint, varnish).'),
      sheen: unit('The soft rim light of cloth, velvet, felt and fuzz.'),
      sheenColor: color,
      glow: { type: 'number', minimum: 0, maximum: 5, description: 'How brightly it glows in its own colour.' },
      subsurface: unit('Light glowing through from under the surface: skin, wax, jade, leaves.'),
      pattern: {
        description: 'A pattern drawn on it: a kind, or the kind with its settings. "none" takes it off.',
        oneOf: [
          { type: 'string', enum: PATTERN_KINDS },
          obj({ kind: { type: 'string', enum: PATTERN_KINDS }, color2: { ...color, description: 'The second colour of the pattern (the first is the shape\'s colour).' }, scale: { type: 'number', description: 'How big one repeat is, mm (default 60).' }, bump: unit('Relief: how much it stands out from the surface.'), angle: { type: 'number', description: 'Turns the pattern, degrees.' } }),
        ],
      },
      image: { oneOf: [{ type: 'string' }, { type: 'null' }], description: 'A picture to lay on it: an artifact id (file_...) or a path; the host reads it. null takes it off.' },
      imageScale: { type: 'number', description: 'How big one repeat of the picture is, mm (default 100).' },
      reset: { type: 'boolean', description: 'Put every number back to the material preset\'s (keeps the pattern and picture).' },
    }),
  },
  {
    name: 'hair_set',
    description:
      'Grow hair or fur on shapes, change it, or take it off (remove: true). style "strands" is separate hairs that fall, curl and gather into locks (a head of hair, a mane, a tail, grass); "fur" is a dense short coat (an animal, a teddy, a rug, moss). Give only what should change; the rest keeps its value. Lengths in mm, density in hairs per cm². Grooming (combing, cutting and puffing where the hair goes) is the person\'s, with the brush in the window\'s Hair card; their strokes stay when you change the numbers. Suggest settings and explain them, but the look is theirs to decide.',
    inputSchema: obj({
      id: { type: 'string' },
      ids,
      style: { type: 'string', enum: ['strands', 'fur'] },
      length: { type: 'number', minimum: 1, maximum: 400, description: 'mm (default 40 for strands, 8 for fur).' },
      density: { type: 'number', minimum: 0.2, maximum: 80, description: 'Hairs per cm² (default 30 strands, 40 fur).' },
      thickness: { type: 'number', minimum: 0.05, maximum: 3, description: 'Width of a hair at its root, mm.' },
      curl: unit('0 straight, 0.3 wavy, 1 tight curls.'),
      frizz: unit('Random wander along each hair.'),
      clump: unit('How much neighbouring hairs gather into locks.'),
      droop: unit('How much it falls under its own weight: 0 stiff, 1 limp.'),
      shine: unit('The highlight band along the hair.'),
      rootColor: color,
      tipColor: color,
      seed: { type: 'integer', description: 'Another number grows another, equally good, head of hair.' },
      clearGrooming: { type: 'boolean', description: 'Forget the person\'s grooming strokes. Only when they ask.' },
      remove: { type: 'boolean', description: 'Take the hair off.' },
    }),
  },
  {
    name: 'hair_groom',
    description: 'The person\'s grooming stroke on a shape\'s hair (comb, cut, lengthen, puff). Not for the agent: styling hair by hand is the person\'s.',
    inputSchema: obj({ id: { type: 'string' }, stroke: obj({ tool: { type: 'string', enum: ['comb', 'cut', 'lengthen', 'puff'] }, path: { type: 'array', items: { type: 'number' } }, radius: { type: 'number' }, strength: { type: 'number' } }, ['tool', 'path', 'radius', 'strength']) }, ['id', 'stroke']),
    authority: 'person',
  },
  {
    name: 'scene_look',
    description: 'How the whole scene is lit: the surroundings glass, metal and hair reflect ("studio" soft and even, "daylight" sky and sun, "sunset" warm and low, "night" dark and blue) and exposure (overall brightness, 0.3 to 2, default 1). Saved with the model; exported files do not carry it.',
    inputSchema: obj({ environment: { type: 'string', enum: ['studio', 'daylight', 'sunset', 'night'] }, exposure: { type: 'number', minimum: 0.3, maximum: 2 } }),
  },
  {
    name: 'shape_resize',
    description: 'Set a shape\'s overall width (x), depth (y) and/or height (z). Corners and bevels stay valid. A mesh from a file is scaled to match.',
    inputSchema: obj({ id: { type: 'string' }, width: { type: 'number' }, depth: { type: 'number' }, height: { type: 'number' } }, ['id']),
  },
  {
    name: 'face_set',
    description: 'Type a number for a face, as a person would: set the height (top/bottom) or the size across a wall. The shape grows or shrinks to match.',
    inputSchema: obj({ id: { type: 'string' }, face, value: { type: 'number' } }, ['id', 'face', 'value']),
  },
  {
    name: 'face_push',
    description: 'Push or pull a face by a distance (positive pulls it outward, negative pushes it in).',
    inputSchema: obj({ id: { type: 'string' }, face, by: { type: 'number' } }, ['id', 'face', 'by']),
  },
  {
    name: 'edge_bevel',
    description:
      'Bevel edges: curved ("round") or flat ("chamfer"). Choose edges by list, by group (top, bottom, corner = vertical corners, all) or every edge around a face. size 0 removes the bevel; for vertical corners size is the corner radius. Sizes are held to what the shape allows; the result reports the size you got.',
    inputSchema: obj(
      {
        id: { type: 'string' },
        edges: { type: 'array', items: obj({ kind: { type: 'string', enum: ['top', 'bottom', 'corner'] }, index: { type: 'integer' } }, ['kind', 'index']) },
        group: { type: 'string', enum: ['top', 'bottom', 'corner', 'all'] },
        aroundFace: face,
        size: { type: 'number' },
        style: { type: 'string', enum: ['round', 'chamfer'] },
      },
      ['id', 'size']
    ),
  },
  { name: 'shape_delete', description: 'Delete shapes (and their group-mates, and the copies of their live repeats).', inputSchema: obj({ ids }, ['ids']) },
  {
    name: 'shape_duplicate',
    description: 'Duplicate shapes, offset by (35, −35) mm unless by is given.',
    inputSchema: obj({ ids, by: obj({ x: { type: 'number' }, y: { type: 'number' } }) }, ['ids']),
  },
  { name: 'group_create', description: 'Group shapes so they select, move and turn together, and give the group a name (it becomes the object name in GLB export). Groups nest: a group that is wholly inside the ids is put inside the new one, so group "head" + "body" makes one "character".', inputSchema: obj({ ids, name: { type: 'string' } }, ['ids']) },
  { name: 'group_enter', description: 'Open a group for editing from the inside, as the person does with Edit inside: the window shows only its shapes, and each is picked on its own. It changes nothing in the model and is only a view, shown when Visible work is on. Leave with group_exit.', inputSchema: obj({ group: { type: 'string' } }, ['group']) },
  { name: 'group_exit', description: 'Leave the group opened with group_enter (a view in the person\'s window; the model does not change).', inputSchema: obj({}) },
  { name: 'group_rename', description: 'Rename a group (e.g. "head"). Find group ids with scene_get.', inputSchema: obj({ group: { type: 'string' }, name: { type: 'string' } }, ['group', 'name']) },
  {
    name: 'library_list',
    description: 'The project library: reusable objects with their size and how many linked copies are placed.',
    inputSchema: obj({}),
    readOnly: true,
  },
  {
    name: 'library_save',
    description: 'Save a group (or one ungrouped shape) to the project library under its name. The library keeps its own copy and the shapes stay as they are. With linked:true the group instead becomes the first linked copy. If the group was opened with object_unlink it updates its library object instead, and every linked copy follows.',
    inputSchema: obj({ group: { type: 'string' }, id: { type: 'string', description: 'A single ungrouped shape, when there is no group.' }, name: { type: 'string' }, linked: { type: 'boolean', description: 'Make the saved group a linked copy. Default false.' } }),
  },
  {
    name: 'library_place',
    description: 'Place a copy of a library object (default: beside the scene; or on top of a shape). The copy is independent: ordinary shapes in a group that nothing follows, free to edit. With linked:true it is a linked copy instead: it moves, turns and deletes as one piece and follows its library object (to change the object use object_unlink then library_save).',
    inputSchema: obj({ item: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' }, angle: { type: 'number', description: 'Degrees, counter-clockwise from above.' }, onTopOf: { type: 'string' }, name: { type: 'string' }, linked: { type: 'boolean' } }, ['item']),
  },
  {
    name: 'object_unlink',
    description: 'Open a linked copy for editing: its shapes become ordinary, you edit them, then library_save the group to update the library object (all copies follow). With forget:true it becomes separate shapes for good.',
    inputSchema: obj({ group: { type: 'string' }, forget: { type: 'boolean' } }, ['group']),
  },
  { name: 'library_thumbnail', description: 'A small picture of a library object (or of a shape group in the scene via `shapes`) as SVG text: isometric, coloured, no GL needed.', inputSchema: obj({ item: { type: 'string' }, shapes: { type: 'array', items: { type: 'string' } }, size: { type: 'number', description: 'Pixels, default 96.' } }), readOnly: true },
  { name: 'library_share', description: 'Keep a library object in the app-wide library too, so every project can place it (shared:false stops that; placed copies stay). Only the live app has an app-wide library; elsewhere use library_export / library_import to carry objects between projects.', inputSchema: obj({ item: { type: 'string' }, shared: { type: 'boolean', description: 'Default true.' } }, ['item']) },
  { name: 'library_export', description: 'The library objects as JSON (all, or the ones in `items`), to keep or to hand to library_import in another project.', inputSchema: obj({ items: { type: 'array', items: { type: 'string' } } }), readOnly: true },
  { name: 'library_import', description: 'Add library objects from library_export. An object already here is replaced only by a newer one (its linked copies follow).', inputSchema: obj({ items: { type: 'array', items: { type: 'object' } } }, ['items']) },
  { name: 'library_rename', description: 'Rename a library object.', inputSchema: obj({ item: { type: 'string' }, name: { type: 'string' } }, ['item', 'name']) },
  { name: 'library_remove', description: 'Remove a library object. Its placed copies stay as ordinary shapes.', inputSchema: obj({ item: { type: 'string' } }, ['item']) },
  { name: 'group_remove', description: 'Dissolve one group (its shapes and inner groups stay, moving up into the group around it).', inputSchema: obj({ group: { type: 'string' } }, ['group']) },
  {
    name: 'shapes_join',
    description: 'Join shapes into one solid: outlines are united wherever they overlap or touch, each keeping its own height and elevation. Bevels on the inputs are not kept.',
    inputSchema: obj({ ids }, ['ids']),
  },
  {
    name: 'shapes_subtract',
    description: 'Cut the cutters out of the "from" shapes where they overlap in height (the cutters are used up). A short cutter leaves a slab above and below.',
    inputSchema: obj({ from: ids, cutters: ids }, ['from', 'cutters']),
  },
  {
    name: 'repeat_set',
    description:
      'Make (or change) a live repeat: copies of a shape equally spaced along a straight or curved path, or around a circle. The copies follow the shape: edit the source and all of them update. count includes the original. Path: give "end", or "direction" (degrees) and "gap"; "bend" curves it. Around: "center" of the circle. Call again with the same id to change the repeat.',
    inputSchema: obj(
      {
        id: { type: 'string', description: 'The shape to repeat.' },
        kind: { type: 'string', enum: ['path', 'around'] },
        count: { type: 'integer' },
        gap: { type: 'number', description: 'Distance between neighbours along the path, mm.' },
        end: point,
        direction: { type: 'number' },
        bend: { oneOf: [point, { type: 'null' }] },
        center: point,
        follow: { type: 'boolean', description: 'Turn each copy to face along the path.' },
      },
      ['id']
    ),
  },
  { name: 'repeat_remove', description: 'Let go of a live repeat: its copies stay as ordinary shapes you can edit one by one.', inputSchema: obj({ id: { type: 'string' } }, ['id']) },
  { name: 'doc_get', description: 'The whole document as JSON (shapes, groups, repeats): save it, or hand it back to doc_set later.', inputSchema: obj({}), readOnly: true },
  { name: 'doc_set', description: 'Replace the whole model with a document from doc_get.', inputSchema: obj({ doc: { type: 'object' } }, ['doc']) },
  { name: 'doc_clear', description: 'Remove every shape.', inputSchema: obj({}) },
  {
    name: 'history_log',
    description: 'What has been done to the model, oldest first: each command with who made it (you, or the person in the window), a short account and the revision after it. Use since_revision (the revision you last saw) to see what the person changed while you were not looking.',
    inputSchema: obj({ last: { type: 'integer', description: 'How many of the latest commands (default 20, at most 100).' }, since_revision: { type: 'integer', description: 'Only commands after this revision.' } }),
    readOnly: true,
  },
  { name: 'history_undo', description: 'Undo the last change.', inputSchema: obj({}) },
  { name: 'history_redo', description: 'Redo the last undone change.', inputSchema: obj({}) },
  {
    name: 'export',
    description: 'Export the visible shapes. format "stl" (binary, Z-up, returned as base64), "glb" (binary glTF for game engines: metres, Y-up, keeps colours and materials, returned as base64), "obj" (text) or "json" (the document). glb options: scale (output metres per scene mm, default 0.001) and pivot ("scene" as placed, "asset" centred on the ground, "shape" one pivot per shape at the centre of its base).',
    inputSchema: obj({ format: { type: 'string', enum: ['stl', 'glb', 'obj', 'json'] }, scale: { type: 'number' }, pivot: { type: 'string', enum: ['scene', 'asset', 'shape'] } }, ['format']),
    readOnly: true,
  },
  {
    name: 'batch',
    description: 'Run several commands in order. By default all-or-nothing: if one fails nothing is changed and you are told which. Later commands can use ids returned earlier only by calling again, so give shapes explicit names and look them up with scene_get, or use ids from the response.',
    inputSchema: obj({ commands: { type: 'array', items: obj({ tool: { type: 'string' }, args: { type: 'object' } }, ['tool']) }, atomic: { type: 'boolean' } }, ['commands']),
  },
  // Only the live app can do these: they need a screen.
  { name: 'ui_select', description: 'Select shapes in the live app, so the person sees what you mean.', inputSchema: obj({ ids: { type: 'array', items: { type: 'string' } } }, ['ids']), uiOnly: true },
  {
    name: 'ui_view',
    description: 'Turn the live app\'s camera: iso, top, bottom, front, back, left or right; "fit" frames everything.',
    inputSchema: obj({ view: { type: 'string', enum: ['iso', 'top', 'bottom', 'front', 'back', 'left', 'right', 'fit'] } }, ['view']),
    uiOnly: true,
  },
  { name: 'ui_xray', description: 'Turn See through mode on or off in the live app.', inputSchema: obj({ on: { type: 'boolean' } }, ['on']), uiOnly: true },
  { name: 'ui_screenshot', description: 'A PNG of the live app\'s 3D view, as a data URL.', inputSchema: obj({}), readOnly: true, uiOnly: true },
];

export const toolByName = (name: string) => TOOL_SPECS.find((t) => t.name === name);

export interface ToolContext {
  doc: Doc;
  ids: IdGen;
}

export interface ToolOutcome {
  doc: Doc;
  result: unknown;
}

const asArgs = (args: unknown): Record<string, any> => (args && typeof args === 'object' ? (args as Record<string, any>) : {});

/** Runs one document tool against a document: pure, no history, no side effects. Throws AgentError on a bad request. */
export function runDocTool(ctx: ToolContext, name: string, rawArgs: unknown): ToolOutcome {
  const a = asArgs(rawArgs);
  const { doc, ids } = ctx;
  const done = <T>(r: ops.OpResult<T>): ToolOutcome => ({ doc: r.doc, result: r.result });
  switch (name) {
    case 'scene_get':
      return { doc, result: sceneSummary(doc, { includeCopies: !!a.includeCopies }) };
    case 'shape_get': {
      const b = ops.need(doc, a.id);
      if (b.mesh) return { doc, result: { summary: summarize(doc, b), note: 'A mesh from a file: a triangle surface with no outline, faces or edges to edit.' } };
      return { doc, result: { summary: summarize(doc, b), outline: { points: b.points, basePoints: b.basePoints, cornerRadii: b.cornerRadii, holes: b.holes }, faces: describeFaces(b), edges: describeEdgesOf(b) } };
    }
    case 'shape_faces':
      return { doc, result: describeFaces(ops.need(doc, a.id)) };
    case 'shape_edges':
      return { doc, result: describeEdgesOf(ops.need(doc, a.id)) };
    case 'shape_measure': {
      const b = ops.need(doc, a.id);
      const report = meshReport(b);
      return { doc, result: report ?? fail('That shape has no solid (its outline is degenerate).') };
    }
    case 'shape_add':
      return done(ops.addShape(doc, ids, a as ops.AddShapeArgs));
    case 'shape_draw':
      return done(ops.drawShape(doc, ids, a as ops.DrawArgs));
    case 'shape_cut':
      return done(ops.cutInto(doc, ids, a as ops.CutArgs));
    case 'shape_set':
      return done(ops.setShape(doc, a as ops.SetArgs));
    case 'shape_move':
      return done(ops.moveShapes(doc, a as ops.MoveArgs));
    case 'shape_turn':
      return done(ops.turnShapes(doc, a as ops.TurnArgs));
    case 'mesh_import':
      return done(ops.importMesh(doc, ids, a as ops.ImportMeshArgs));
    case 'sculpt_apply':
      return done(ops.applySculpt(doc, a as unknown as ops.ApplySculptArgs));
    case 'sculpt_blend':
      return done(ops.sculptBlend(doc, ids, a as unknown as ops.BlendArgs));
    case 'sculpt_loft':
      return done(ops.sculptLoft(doc, ids, a as unknown as ops.LoftArgs));
    case 'sculpt_smooth':
      return done(ops.smoothShape(doc, a as unknown as ops.SmoothArgs));
    case 'surface_set':
      return done(ops.setSurface(doc, a as ops.SurfaceArgs));
    case 'hair_set':
      return done(ops.setHair(doc, a as ops.HairArgs));
    case 'hair_groom':
      return done(ops.groomHair(doc, a as unknown as ops.GroomArgs));
    case 'scene_look':
      return done(ops.setLook(doc, a));
    case 'shape_resize':
      return done(ops.resizeShape(doc, a as { id: string }));
    case 'face_set':
      return done(ops.setFace(doc, a as { id: string; face: ops.FaceSpec; value: number }));
    case 'face_push':
      return done(ops.pushFace(doc, a as { id: string; face: ops.FaceSpec; by: number }));
    case 'edge_bevel':
      return done(ops.bevelEdges(doc, a as ops.BevelArgs));
    case 'shape_delete':
      return done(ops.deleteShapes(doc, a as { ids: string[] }));
    case 'shape_duplicate':
      return done(ops.duplicateShapes(doc, ids, a as { ids: string[] }));
    case 'group_create':
      return done(ops.groupShapes(doc, ids, a as { ids: string[] }));
    case 'group_rename':
      return done(ops.renameGroup(doc, a as { group: string; name: string }));
    case 'group_enter':
      return done(ops.enterGroup(doc, a as { group: string }));
    case 'group_exit':
      return { doc: ctx.doc, result: { note: 'Back out of the group in the person\'s window (a view only; the model did not change).' } };
    case 'library_list':
      return { doc: ctx.doc, result: { items: libraryItems(doc) } };
    case 'library_save':
      return done(ops.saveToLibrary(doc, ids, a as { group?: string; id?: string; name?: string; linked?: boolean }));
    case 'library_place':
      return done(ops.placeFromLibrary(doc, ids, a as ops.PlaceArgs));
    case 'object_unlink':
      return done(ops.unlinkObject(doc, ids, a as { group: string; forget?: boolean }));
    case 'library_thumbnail': {
      const size = Math.max(16, Math.min(512, Number(a.size) || 96));
      if (Array.isArray(a.shapes)) return { doc, result: { svg: thumbnailSvg(a.shapes.map((id: string) => ops.need(doc, id)), size) } };
      const item = doc.library.find((i) => i.id === a.item);
      if (!item) throw new AgentError(`No library object "${String(a.item)}".`, `Library: ${doc.library.map((i) => i.id).join(', ') || 'empty'}`);
      return { doc, result: { item: item.id, svg: thumbnailSvg(item.bodies, size) } };
    }
    case 'library_share':
      return done(ops.shareLibraryItem(doc, a as { item: string; shared?: boolean }));
    case 'library_export': {
      const want = Array.isArray(a.items) ? new Set<string>(a.items) : null;
      return { doc, result: { items: doc.library.filter((i) => !want || want.has(i.id)) } };
    }
    case 'library_import':
      return done(ops.importLibrary(doc, a as { items: unknown }));
    case 'library_rename':
      return done(ops.renameLibraryItem(doc, a as { item: string; name: string }));
    case 'library_remove':
      return done(ops.removeLibraryItem(doc, a as { item: string }));
    case 'group_remove':
      return done(ops.ungroupShapes(doc, ids, a as { group: string }));
    case 'shapes_join':
      return done(ops.joinShapes(doc, ids, a as { ids: string[] }));
    case 'shapes_subtract':
      return done(ops.subtractShapes(doc, ids, { from: a.from, cutters: a.cutters }));
    case 'repeat_set':
      return done(ops.setRepeat(doc, ids, a as ops.RepeatArgs));
    case 'repeat_remove':
      return done(ops.removeRepeat(doc, a as { id: string }));
    default:
      return fail(`Unknown tool "${name}".`, `Tools: ${TOOL_SPECS.map((t) => t.name).join(', ')}`);
  }
}

/** The ids of real shapes mentioned anywhere in a result, so a response can describe them without another call. */
export function mentionedShapes(doc: Doc, result: unknown): Body3D[] {
  const found = new Set<string>();
  const walk = (v: unknown, depth: number) => {
    if (depth > 4 || v === null || v === undefined) return;
    if (typeof v === 'string') {
      if (doc.bodies.some((b) => b.id === v && !b.repeatOf)) found.add(v);
    } else if (Array.isArray(v)) v.forEach((x) => walk(x, depth + 1));
    else if (typeof v === 'object') Object.values(v as Record<string, unknown>).forEach((x) => walk(x, depth + 1));
  };
  walk(result, 0);
  return [...found].map((id) => doc.bodies.find((b) => b.id === id)!).filter(Boolean).slice(0, 12);
}
