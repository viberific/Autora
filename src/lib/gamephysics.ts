/**
 * The bridge from Autora 3D to Autora Games: a part of the 3D model becomes a 3D object in the game (GDevelop's
 * `Scene3D::Model3DObject`, showing a GLB of it), and may be given rigid-body physics (GDevelop's `Physics3D` behaviour, which
 * runs Jolt). The person asks for how it should feel ("heavy", "bouncy", "slippery") and every number stays theirs to change.
 *
 * Pure: it changes a project's JSON in place, from the shapes the editor saves (`templates`, from server/game-catalog.json).
 * Shared by the server (server/gamedesk.ts) and Panacea's Game panels (src/lib/panacea/apps/game.ts).
 *
 * GDevelop's 3D: x to the right, y down the screen, z up toward a 2D camera; 1 metre of physics is `worldScale` (100) pixels.
 * A model's mm become pixels at `scale` pixels per mm (default 1).
 */

type Json = any;

export const PHYSICS3D = "Physics3D::Physics3DBehavior";
/** The behaviour's name on an object, which is also the name of the scene's shared physics settings. */
const PHYSICS_NAME = "Physics3D";
/** A 3D object's own capability behaviour, which the physics behaviour works through. */
export const OBJECT3D = "Object3D";
const MODEL3D = "Scene3D::Model3DObject";
const CUBE3D = "Scene3D::Cube3DObject";

export type BodyType = "Dynamic" | "Static" | "Kinematic";
export type BodyShape = "Box" | "Capsule" | "Cylinder" | "Sphere" | "Mesh";
const BODY_TYPES: BodyType[] = ["Dynamic", "Static", "Kinematic"];
const BODY_SHAPES: BodyShape[] = ["Box", "Sphere", "Capsule", "Cylinder", "Mesh"];

/** How a body should behave, in the words a person uses, and the numbers each sets. A number given as well wins. */
const FEELS: Record<string, { label: string; set: Partial<Physics> }> = {
  heavy: { label: "heavy", set: { density: 6 } },
  light: { label: "light", set: { density: 0.2 } },
  bouncy: { label: "bouncy", set: { bounce: 0.85 } },
  dead: { label: "lands dead", set: { bounce: 0 } },
  slippery: { label: "slippery", set: { friction: 0.02 } },
  grippy: { label: "grippy", set: { friction: 1 } },
  floaty: { label: "floaty", set: { gravity: 0.25, damping: 0.8 } },
  rolling: { label: "rolls", set: { shape: "Sphere" } },
  fixed: { label: "stays put", set: { body: "Static" } },
  moved: { label: "moved by events", set: { body: "Kinematic" } },
  upright: { label: "stays upright", set: { upright: true } },
};
export const FEEL_WORDS = Object.keys(FEELS);

/** A body's physics in Autora's words. Each maps to one setting of the behaviour. */
export interface Physics {
  body: BodyType;
  shape: BodyShape;
  /** Mass per volume: 1 is water-like. */
  density: number;
  /** 0 ice to 1 rubber on rubber. */
  friction: number;
  /** Restitution: 0 lands dead, 1 bounces back as high. */
  bounce: number;
  /** Times the world's gravity: 0 floats, 1 normal. */
  gravity: number;
  /** How fast it slows in the air, 0 to 1. */
  damping: number;
  /** Never tips over (fixed rotation). */
  upright: boolean;
}

const PHYSICS_RANGES = { density: [0.01, 100], friction: [0, 1], bounce: [0, 1], gravity: [-5, 5], damping: [0, 10] } as const;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const list = (v: unknown): Json[] => (Array.isArray(v) ? v : []);

/** A Physics3D behaviour read in Autora's words. */
export function readPhysics(b: Json): Physics {
  return {
    body: BODY_TYPES.includes(b?.bodyType) ? b.bodyType : "Dynamic",
    shape: BODY_SHAPES.includes(b?.shape) ? b.shape : "Box",
    density: typeof b?.density === "number" ? b.density : 1,
    friction: typeof b?.friction === "number" ? b.friction : 0.3,
    bounce: typeof b?.restitution === "number" ? b.restitution : 0.1,
    gravity: typeof b?.gravityScale === "number" ? b.gravityScale : 1,
    damping: typeof b?.linearDamping === "number" ? b.linearDamping : 0.1,
    upright: b?.fixedRotation === true,
  };
}

/** What a request for physics comes to: feel words first, then numbers (which win). Errors name what was wrong. */
export function physicsOf(spec: Record<string, unknown>, from: Physics): { physics: Physics; feels: string[] } | { error: string } {
  const out: Physics = { ...from };
  const feels: string[] = [];
  const words = Array.isArray(spec.feel) ? spec.feel : typeof spec.feel === "string" ? spec.feel.split(/[\s,]+/) : [];
  for (const w of words.map((x) => String(x).toLowerCase()).filter(Boolean)) {
    const f = FEELS[w];
    if (!f) return { error: `"${w}" is not a feel the bridge knows: ${FEEL_WORDS.join(", ")}. Give numbers for anything else.` };
    Object.assign(out, f.set);
    feels.push(f.label);
  }
  if (spec.body !== undefined) {
    const b = String(spec.body).toLowerCase();
    const t = BODY_TYPES.find((x) => x.toLowerCase() === b);
    if (!t) return { error: `body must be dynamic (falls and is pushed), static (never moves) or kinematic (moved by events).` };
    out.body = t;
  }
  if (spec.shape !== undefined) {
    const s = String(spec.shape).toLowerCase();
    const t = BODY_SHAPES.find((x) => x.toLowerCase() === s);
    if (!t) return { error: `shape must be one of ${BODY_SHAPES.join(", ")}.` };
    out.shape = t;
  }
  for (const k of ["density", "friction", "bounce", "gravity", "damping"] as const) {
    const v = spec[k];
    if (v === undefined) continue;
    const n = Number(v);
    const [lo, hi] = PHYSICS_RANGES[k];
    if (!Number.isFinite(n) || n < lo || n > hi) return { error: `${k} must be a number from ${lo} to ${hi}.` };
    out[k] = n;
  }
  if (spec.upright !== undefined) out.upright = spec.upright === true;
  // Jolt takes an exact mesh only for a body that never moves.
  if (out.shape === "Mesh" && out.body !== "Static") return { error: "an exact (mesh) shape is only for a body that stays put: use Box, Sphere, Capsule or Cylinder for one that moves, or make it static." };
  return { physics: out, feels };
}

/** A Physics3D behaviour for an object, from the editor's template, with these settings. */
function physicsBehavior(template: Json, p: Physics, meshResource = ""): Json {
  return {
    ...JSON.parse(JSON.stringify(template)),
    name: PHYSICS_NAME,
    type: PHYSICS3D,
    object3D: OBJECT3D,
    bodyType: p.body,
    shape: p.shape,
    meshShapeResourceName: p.shape === "Mesh" ? meshResource : "",
    // 0 means "the object's own size" for the dimensions: the body follows the model's box.
    shapeDimensionA: 0,
    shapeDimensionB: 0,
    shapeDimensionC: 0,
    density: clamp(p.density, ...PHYSICS_RANGES.density),
    friction: clamp(p.friction, ...PHYSICS_RANGES.friction),
    restitution: clamp(p.bounce, ...PHYSICS_RANGES.bounce),
    gravityScale: clamp(p.gravity, ...PHYSICS_RANGES.gravity),
    linearDamping: clamp(p.damping, ...PHYSICS_RANGES.damping),
    fixedRotation: p.upright,
  };
}

/** Writes Autora's words into an existing behaviour, keeping what it does not name (collision layers, offsets). */
export function writePhysics(behavior: Json, p: Physics): void {
  behavior.bodyType = p.body;
  behavior.shape = p.shape;
  behavior.density = clamp(p.density, ...PHYSICS_RANGES.density);
  behavior.friction = clamp(p.friction, ...PHYSICS_RANGES.friction);
  behavior.restitution = clamp(p.bounce, ...PHYSICS_RANGES.bounce);
  behavior.gravityScale = clamp(p.gravity, ...PHYSICS_RANGES.gravity);
  behavior.linearDamping = clamp(p.damping, ...PHYSICS_RANGES.damping);
  behavior.fixedRotation = p.upright;
}

/** The scene's shared physics settings (gravity, world scale), made when the first body arrives, as GDevelop saves them. */
function ensurePhysicsWorld(layout: Json): void {
  layout.behaviorsSharedData = list(layout.behaviorsSharedData);
  if (layout.behaviorsSharedData.some((d: Json) => d?.name === PHYSICS_NAME)) return;
  layout.behaviorsSharedData.push({ name: PHYSICS_NAME, type: PHYSICS3D, gravityX: 0, gravityY: 0, gravityZ: -9.8, worldScale: 100 });
}

/** The objects in a scene (and the global ones) that have 3D physics. */
export function physicsBodies(project: Json): Array<{ object: Json; behavior: Json }> {
  const all = [...list(project?.layouts).flatMap((l) => list(l?.objects)), ...list(project?.objects)];
  const seen = new Set<string>();
  const out: Array<{ object: Json; behavior: Json }> = [];
  for (const object of all) {
    if (!object || typeof object.name !== "string" || seen.has(object.name)) continue;
    const behavior = list(object.behaviors).find((b) => b?.type === PHYSICS3D);
    if (behavior) { seen.add(object.name); out.push({ object, behavior }); }
  }
  return out;
}

/** An object name GDevelop takes: letters, digits and underscores, not starting with a digit, not taken by another. */
export function objectNameFor(wanted: string, taken: Set<string>): string {
  let base = wanted.replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "Model";
  if (/^[0-9]/.test(base)) base = `Model_${base}`;
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base}${n}`;
  return name;
}

interface ModelObjectInput {
  /** The object's name (made from the model's name when absent). An existing Model3D object of that name is updated. */
  object?: string;
  /** What the model is called in the 3D window (a group or a shape). */
  modelName: string;
  /** The resource that holds its GLB (already in resources.resources). */
  resource: string;
  /** Its size in mm (x across, y deep, z tall). */
  size: { x: number; y: number; z: number };
  /** Pixels per mm (default 1). */
  scale?: number;
  /** Physics to give it (or keep, when updating); false takes it away; absent leaves it as it is. */
  physics?: Physics | false;
  /** Put one in the scene: where (pixels; z up), or true for the middle of the screen. */
  place?: { x?: number; y?: number; z?: number } | boolean;
  /** Add a floor that stays put, under the middle of the screen, when the scene has none. */
  ground?: boolean;
}

interface Templates {
  objects: Record<string, Json>;
  behaviors: Record<string, Json>;
  instance: Json;
}

/**
 * Puts a model in a scene of the game, or updates the one already there: the object, its size, its physics, an instance, a
 * floor. Returns what it did in a person's words, and the object's name.
 */
export function placeModel(project: Json, layout: Json, input: ModelObjectInput, t: Templates): { object: string; did: string[] } {
  const did: string[] = [];
  layout.objects = list(layout.objects);
  layout.instances = list(layout.instances);
  const scale = input.scale && input.scale > 0 ? input.scale : 1;
  const taken = new Set<string>([...layout.objects, ...list(project.objects)].map((o: Json) => o?.name));
  const named = input.object ? layout.objects.find((o: Json) => o?.name === input.object) : null;
  if (named && named.type !== MODEL3D) throw new Error(`"${input.object}" is a ${named.type}, not a 3D model object: give another name.`);
  const object: Json = named ?? { ...JSON.parse(JSON.stringify(t.objects[MODEL3D])), name: input.object ? objectNameFor(input.object, taken) : objectNameFor(input.modelName, taken) };
  object.content = { ...object.content };
  object.content.modelResourceName = input.resource;
  // GDevelop's width is x, height is y (down the screen), depth is z (up): the model's mm in pixels.
  object.content.width = Math.max(1, Math.round(input.size.x * scale));
  object.content.height = Math.max(1, Math.round(input.size.y * scale));
  object.content.depth = Math.max(1, Math.round(input.size.z * scale));
  object.content.keepAspectRatio = true;
  // The GLB is y-up (glTF's way); a turn of 90° about x stands it up in GDevelop's z-up world, facing the camera as it faced the 3D window's front.
  object.content.rotationX = 90;
  object.content.rotationY = 0;
  object.content.rotationZ = 0;
  // Its position is the middle of its footprint, on the ground (so an instance's z is where it stands), and its centre is the
  // middle of its box: the physics body is centred there, so it rests on the floor rather than half its height above it.
  object.content.originLocation = "BottomCenterZ";
  object.content.centerLocation = "ObjectCenter";
  object.behaviors = list(object.behaviors);
  if (!named) {
    layout.objects.push(object);
    did.push(`made the 3D object ${object.name} from the model "${input.modelName}" (${object.content.width} × ${object.content.height} × ${object.content.depth} px)`);
  } else did.push(`updated ${object.name} from the model "${input.modelName}"`);

  if (input.physics === false) {
    const before = object.behaviors.length;
    object.behaviors = object.behaviors.filter((b: Json) => b?.type !== PHYSICS3D);
    if (object.behaviors.length !== before) did.push(`took the physics off ${object.name}`);
  } else if (input.physics) {
    const had = object.behaviors.find((b: Json) => b?.type === PHYSICS3D);
    if (had) writePhysics(had, input.physics);
    else object.behaviors.push(physicsBehavior(t.behaviors[PHYSICS3D], input.physics, input.resource));
    if (input.physics.shape === "Mesh") (had ?? object.behaviors.at(-1)).meshShapeResourceName = input.resource;
    ensurePhysicsWorld(layout);
    did.push(`gave ${object.name} ${input.physics.body.toLowerCase()} physics (${input.physics.shape.toLowerCase()}, density ${input.physics.density}, friction ${input.physics.friction}, bounce ${input.physics.bounce}${input.physics.gravity !== 1 ? `, gravity ×${input.physics.gravity}` : ""}${input.physics.upright ? ", upright" : ""})`);
  }

  const width = Number(project?.properties?.windowWidth) || 800;
  const height = Number(project?.properties?.windowHeight) || 600;
  if (input.ground && !layout.objects.some((o: Json) => o?.name === "Ground")) {
    const ground: Json = { ...JSON.parse(JSON.stringify(t.objects[CUBE3D])), name: objectNameFor("Ground", taken) };
    ground.content = { ...ground.content, width: width * 2, height: height * 2, depth: 20, tint: "120;128;140" };
    ground.behaviors = [physicsBehavior(t.behaviors[PHYSICS3D], { body: "Static", shape: "Box", density: 1, friction: 0.6, bounce: 0.1, gravity: 1, damping: 0, upright: false })];
    layout.objects.push(ground);
    // A cube's position is its corner: the floor is centred under the screen, its top at z 0.
    layout.instances.push({ ...JSON.parse(JSON.stringify(t.instance)), name: ground.name, x: width / 2 - width, y: height / 2 - height, z: -20, layer: "" });
    ensurePhysicsWorld(layout);
    did.push(`added a floor (${ground.name}) that stays put, its top at z 0`);
  }

  if (input.place) {
    const at = typeof input.place === "object" ? input.place : {};
    // A body that falls starts a little above the floor, so it can be seen to land.
    const dropping = input.physics && input.physics.body === "Dynamic";
    const z = at.z ?? (dropping ? Math.round(object.content.depth * 1.5) : 0);
    const spot = at.x !== undefined || at.y !== undefined ? { x: at.x ?? width / 2, y: at.y ?? height / 2 } : freeSpot(layout, object, width / 2, height / 2);
    layout.instances.push({ ...JSON.parse(JSON.stringify(t.instance)), name: object.name, x: Math.round(spot.x), y: Math.round(spot.y), z, layer: "" });
    did.push(`placed ${object.name} at ${Math.round(spot.x)}, ${Math.round(spot.y)}${z ? `, ${z} up` : ""}`);
  }
  return { object: object.name, did };
}

/**
 * Where a new object goes when no place is given: the middle of the screen, or, when something is already there, the nearest
 * spot to its right that is clear of every model already placed, so sending one more thing never drops it onto another.
 */
function freeSpot(layout: Json, object: Json, x0: number, y0: number): { x: number; y: number } {
  const half = (o: Json) => ({ w: (Number(o?.content?.width) || 0) / 2, h: (Number(o?.content?.height) || 0) / 2 });
  const me = half(object);
  const boxes = list(layout.instances)
    .map((i: Json) => ({ i, o: list(layout.objects).find((o: Json) => o?.name === i?.name) }))
    .filter(({ o }) => o?.type === MODEL3D)
    .map(({ i, o }) => ({ x: Number(i.x) || 0, y: Number(i.y) || 0, ...half(o) }));
  const gap = 20;
  const clear = (x: number) => boxes.every((b) => Math.abs(b.x - x) >= b.w + me.w + gap || Math.abs(b.y - y0) >= b.h + me.h + gap);
  let x = x0;
  for (let n = 0; n < 200 && !clear(x); n++) x += me.w * 2 + gap;
  return { x, y: y0 };
}
