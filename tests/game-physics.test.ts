/**
 * The bridge from Autora 3D to Autora Games, without a browser (src/lib/gamephysics.ts and the Game panels' adapter): how a
 * person's words ("bouncy", "heavy", "stays put") become the Physics3D behaviour's numbers, how a model becomes a 3D object
 * with the right size, origin and physics (as GDevelop saves them), that an update keeps what it does not name, and that the
 * scene's physics world and the floor are made once. The real engine running it is tests/ui-game-physics.test.ts.
 *
 *   npx tsx tests/game-physics.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { FEEL_WORDS, OBJECT3D, PHYSICS3D, objectNameFor, physicsOf, placeModel, readPhysics } from "../src/lib/gamephysics";
import { gameOptions, readGame, writeGame } from "../src/lib/panacea/apps/game";

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

const catalog = JSON.parse(fs.readFileSync("server/game-catalog.json", "utf8"));
const starter = () => JSON.parse(fs.readFileSync("server/game-starter.json", "utf8"));
const t = catalog.templates;
const base = readPhysics({});

test("words become numbers, numbers win over words, and what cannot work is refused with the reason", () => {
  const bouncy = physicsOf({ feel: ["bouncy", "heavy"] }, base);
  assert.ok(!("error" in bouncy));
  if ("error" in bouncy) return;
  assert.equal(bouncy.physics.bounce, 0.85);
  assert.equal(bouncy.physics.density, 6);
  assert.deepEqual(bouncy.feels, ["bouncy", "heavy"]);
  const won = physicsOf({ feel: "bouncy", bounce: 0.3 }, base);
  assert.ok(!("error" in won) && won.physics.bounce === 0.3, "a number wins over a word");
  assert.ok("error" in physicsOf({ feel: ["wobbly"] }, base), "an unknown word");
  assert.ok("error" in physicsOf({ friction: 3 }, base), "out of range");
  assert.ok("error" in physicsOf({ body: "flying" }, base));
  const mesh = physicsOf({ shape: "mesh" }, base);
  assert.ok("error" in mesh && /stays put/.test(mesh.error), "an exact mesh cannot move (Jolt)");
  assert.ok(!("error" in physicsOf({ feel: ["fixed"], shape: "mesh" }, base)), "but can stay put");
  for (const w of FEEL_WORDS) assert.ok(!("error" in physicsOf({ feel: [w] }, base)), w);
});

test("a model becomes a 3D object as GDevelop saves it: its size in pixels, standing on its origin, centred for physics", () => {
  const project = starter();
  const layout = project.layouts[0];
  const p = physicsOf({ body: "dynamic", feel: ["bouncy"] }, base);
  assert.ok(!("error" in p));
  if ("error" in p) return;
  const out = placeModel(project, layout, { modelName: "Barrel", resource: "Barrel_model", size: { x: 40, y: 30, z: 60 }, scale: 2, physics: p.physics, place: true, ground: true }, t);
  assert.equal(out.object, "Barrel");
  const o = layout.objects.find((x: any) => x.name === "Barrel");
  assert.equal(o.type, "Scene3D::Model3DObject");
  assert.deepEqual([o.content.width, o.content.height, o.content.depth], [80, 60, 120]);
  assert.equal(o.content.modelResourceName, "Barrel_model");
  assert.deepEqual([o.content.originLocation, o.content.centerLocation], ["BottomCenterZ", "ObjectCenter"], "stands on its z; the body is centred on it");
  const b = o.behaviors.find((x: any) => x.type === PHYSICS3D);
  assert.equal(b.name, "Physics3D");
  assert.equal(b.object3D, OBJECT3D);
  assert.equal(b.bodyType, "Dynamic");
  assert.equal(b.restitution, 0.85);
  assert.equal(layout.behaviorsSharedData.filter((d: any) => d.name === "Physics3D").length, 1);
  assert.deepEqual(layout.behaviorsSharedData[0], { name: "Physics3D", type: PHYSICS3D, gravityX: 0, gravityY: 0, gravityZ: -9.8, worldScale: 100 });
  const ground = layout.objects.find((x: any) => x.name === "Ground");
  assert.equal(ground.type, "Scene3D::Cube3DObject");
  assert.equal(ground.behaviors[0].bodyType, "Static");
  const placed = layout.instances.find((i: any) => i.name === "Barrel");
  assert.ok(placed.z > 0, "a falling body starts above the floor");
  assert.equal(layout.instances.filter((i: any) => i.name === "Ground").length, 1);
});

test("an update changes what it names and keeps the rest: physics, placements, the floor", () => {
  const project = starter();
  const layout = project.layouts[0];
  const p = physicsOf({ feel: ["slippery"] }, base);
  if ("error" in p) throw new Error(p.error);
  placeModel(project, layout, { modelName: "Box", resource: "Box_model", size: { x: 10, y: 10, z: 10 }, physics: p.physics, place: true, ground: true }, t);
  const layersBefore = layout.objects.find((x: any) => x.name === "Box").behaviors[0].layers;
  placeModel(project, layout, { object: "Box", modelName: "Box", resource: "Box_model", size: { x: 20, y: 10, z: 30 }, ground: true }, t);
  const o = layout.objects.find((x: any) => x.name === "Box");
  assert.equal(o.content.width, 20);
  assert.equal(o.content.depth, 30);
  assert.equal(o.behaviors.length, 1, "physics kept");
  assert.equal(o.behaviors[0].friction, 0.02);
  assert.equal(o.behaviors[0].layers, layersBefore, "what Autora does not name is left alone");
  assert.equal(layout.instances.filter((i: any) => i.name === "Box").length, 1, "not placed again");
  assert.equal(layout.objects.filter((x: any) => x.name.startsWith("Ground")).length, 1, "one floor");
  placeModel(project, layout, { object: "Box", modelName: "Box", resource: "Box_model", size: { x: 20, y: 10, z: 30 }, physics: false }, t);
  assert.equal(layout.objects.find((x: any) => x.name === "Box").behaviors.length, 0, "physics: false takes it off");
  const sprite = { ...JSON.parse(JSON.stringify(t.objects.Sprite)), name: "Hero" };
  layout.objects.push(sprite);
  assert.throws(() => placeModel(project, layout, { object: "Hero", modelName: "Hero", resource: "r", size: { x: 1, y: 1, z: 1 } }, t), /not a 3D model object/);
});

test("a second model sent without a place goes beside the first, never onto it", () => {
  const project = starter();
  const layout = project.layouts[0];
  placeModel(project, layout, { modelName: "Barrel", resource: "a", size: { x: 40, y: 40, z: 60 }, place: true }, t);
  placeModel(project, layout, { modelName: "Crate", resource: "b", size: { x: 50, y: 50, z: 50 }, place: true }, t);
  const [a, b] = layout.instances;
  assert.ok(Math.abs(a.x - b.x) >= 20 + 25 + 20, `apart: ${a.x} and ${b.x}`);
  placeModel(project, layout, { modelName: "Cone", resource: "c", size: { x: 10, y: 10, z: 10 }, place: { x: 400, y: 300 } }, t);
  assert.equal(layout.instances[2].x, 400, "a place given is kept");
});

test("names are ones GDevelop takes, and never collide", () => {
  assert.equal(objectNameFor("Big barrel!", new Set()), "Big_barrel");
  assert.equal(objectNameFor("3 legs", new Set()), "Model_3_legs");
  assert.equal(objectNameFor("Barrel", new Set(["Barrel", "Barrel2"])), "Barrel3");
});

test("Panacea's 3D physics panel reads and sets the body's numbers in the person's words", () => {
  const project = starter();
  const layout = project.layouts[0];
  const p = physicsOf({}, base);
  if ("error" in p) throw new Error(p.error);
  placeModel(project, layout, { modelName: "Ball", resource: "Ball_model", size: { x: 10, y: 10, z: 10 }, physics: p.physics }, t);
  assert.deepEqual(gameOptions(project).map((o) => o.value), ["Ball"], "a body can be picked");
  assert.equal(readGame(project, "game.body", "Ball"), "dynamic");
  assert.equal(readGame(project, "game.bounce", "Ball"), 10);
  assert.ok(!("error" in writeGame(project, "game.bounce", 70, "Ball")));
  assert.equal(layout.objects[0].behaviors[0].restitution, 0.7);
  assert.ok(!("error" in writeGame(project, "game.grip", 5, "Ball")));
  assert.equal(layout.objects[0].behaviors[0].friction, 0.05);
  assert.ok(!("error" in writeGame(project, "game.body", "static", "Ball")));
  assert.equal(readGame(project, "game.body", "Ball"), "static");
  assert.ok("error" in writeGame(project, "game.weight", "lots", "Ball"));
  assert.ok("error" in writeGame(starter(), "game.bounce", 50, "Ball"), "no body: it says how to get one");
});

console.log(`game-physics: ${passed} passed, 0 failed`);
