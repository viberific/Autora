/**
 * Autora 3D's surfaces and hair: what a shape is made of (a preset with its own numbers on top, a pattern the modeller
 * draws, a picture laid on it), the hair or fur grown from it (seeded, groomed by the person's strokes), the scene's light,
 * and how all of it leaves in a GLB and comes back in. Also that the agent is refused the grooming brush, and that
 * Panacea's 3D panels read the same numbers the modeller does.
 *
 *   npx tsx tests/surface-3d.test.ts
 */
import assert from "node:assert/strict";
import zlib from "node:zlib";
import * as THREE from "three";

/** This file's three.js and the modeller's are two copies with the same shape: hand the modeller's code ours as its own. */
const its = <T>(x: unknown) => x as T;
type Its<F extends (...a: never[]) => unknown> = Parameters<F>;
import { Engine } from "../autora-3d/src/core/engine";
import { emptyDoc, parseDoc } from "../autora-3d/src/core/doc";
import { MATERIAL_PRESETS, type Body3D } from "../autora-3d/src/types";
import { buildBodyGeometry } from "../autora-3d/src/utils/bodyGeometry";
import { addBoxUVs, encodePng, imageDataUrl, patternPixels, PATTERN_KINDS, resolveSurface } from "../autora-3d/src/utils/surface";
import { DEFAULT_HAIR, furShell, groomer, growStrands, hairGeometry, settleHair, MAX_STRANDS } from "../autora-3d/src/utils/hair";
import { glbBytes } from "../autora-3d/src/utils/glb";
import { stlBytes } from "../autora-3d/src/utils/serialize";
import { placeMesh, readMesh } from "../autora-3d/src/utils/meshImport";
import { describeEdit } from "../autora-3d/src/core/commands";
import { FINISH_OF, HAIR_START, MATERIALS, PATTERN_KINDS as PANEL_PATTERNS, modelCommands, readModel, type ModelDoc } from "../src/lib/panacea/apps/model";

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

const fresh = async () => {
  const e = new Engine(emptyDoc());
  const r = await e.execute("shape_add", { kind: "box", width: 60, depth: 40, height: 30, name: "Box" });
  assert.ok(r.ok, r.error);
  return { e, id: (r.result as { id: string }).id };
};
const bodyOf = (e: Engine, id: string) => e.getDoc().bodies.find((b) => b.id === id)!;
const run = async (e: Engine, name: string, args: Record<string, unknown>) => {
  const r = await e.execute(name, args);
  assert.ok(r.ok, `${name}: ${r.error}`);
  return r.result as any;
};
const glbJson = (glb: Uint8Array) => JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + new DataView(glb.buffer, glb.byteOffset).getUint32(12, true))));
/** A tiny real PNG: 2 by 2, red, green, blue, white. */
const png2 = () => encodePng(2, 2, new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]));

// ---------------------------------------------------------------- surface --

await test("a preset is a place to start: numbers on top override it, a new preset clears them, and the range is held", async () => {
  const { e, id } = await fresh();
  await run(e, "surface_set", { id, preset: "glass", roughness: 0.4, ior: 1.33 });
  let s = resolveSurface(bodyOf(e, id));
  assert.equal(bodyOf(e, id).materialType, "glass");
  assert.equal(s.roughness, 0.4);
  assert.equal(s.ior, 1.33);
  assert.equal(s.transmission, 0.8, "the rest is the preset's");
  await run(e, "surface_set", { id, preset: "velvet" });
  s = resolveSurface(bodyOf(e, id));
  assert.equal(s.roughness, 0.9, "a preset chosen again clears the fine-tuning");
  assert.equal(s.sheen, 1);
  const bad = await e.execute("surface_set", { id, roughness: 3 });
  assert.equal(bad.ok, false);
  assert.match(bad.error!, /between 0 and 1/);
  assert.equal((await e.execute("surface_set", { id, pattern: "plaid" })).ok, false);
  assert.equal((await e.execute("surface_set", { id, image: "data:text/plain;base64,aGk=" })).ok, false, "only PNG or JPEG");
  for (const m of MATERIAL_PRESETS) assert.ok((await e.execute("shape_set", { id, material: m.id })).ok, m.id);
});

await test("a pattern keeps its settings when only one changes, and a preset keeps the pattern; reset keeps it too", async () => {
  const { e, id } = await fresh();
  await run(e, "surface_set", { id, pattern: { kind: "wood", scale: 40, color2: "#112233" } });
  await run(e, "surface_set", { id, pattern: { bump: 0.8 } });
  let p = bodyOf(e, id).surface!.pattern!;
  assert.deepEqual([p.kind, p.scale, p.color2, p.bump], ["wood", 40, "#112233", 0.8]);
  await run(e, "surface_set", { id, preset: "metal", roughness: 0.5 });
  await run(e, "surface_set", { id, reset: true });
  p = bodyOf(e, id).surface!.pattern!;
  assert.equal(p.kind, "wood");
  assert.equal(resolveSurface(bodyOf(e, id)).roughness, 0.2, "reset puts the numbers back to metal's");
  await run(e, "surface_set", { id, pattern: "none" });
  assert.equal(bodyOf(e, id).surface, undefined, "nothing of its own left");
});

await test("several shapes at once, and copies of a live repeat follow their source's surface", async () => {
  const { e, id } = await fresh();
  const other = (await run(e, "shape_add", { kind: "cylinder", x: 200 })).id;
  await run(e, "surface_set", { ids: [id, other], preset: "rubber" });
  assert.equal(bodyOf(e, other).materialType, "rubber");
  await run(e, "repeat_set", { id, kind: "path", count: 3, gap: 80, direction: 90 });
  await run(e, "surface_set", { id, sheen: 0.5 });
  const copies = e.getDoc().bodies.filter((b) => b.repeatOf === id);
  assert.equal(copies.length, 2);
  for (const c of copies) assert.equal(c.surface?.sheen, 0.5);
  assert.equal((await e.execute("surface_set", { id: copies[0].id, sheen: 1 })).ok, false, "a copy is edited through its source");
});

await test("every pattern draws a tile that repeats without a seam, the same every time", () => {
  for (const kind of PATTERN_KINDS.filter((k) => k !== "none")) {
    const a = patternPixels(kind, "#336699", "#ffcc00", 64);
    const b = patternPixels(kind, "#336699", "#ffcc00", 64);
    assert.deepEqual(a.rgba, b.rgba, `${kind}: seeded`);
    let edge = 0;
    let inside = 0;
    for (let y = 0; y < 64; y++) {
      const px = (x: number) => a.rgba[(y * 64 + x) * 4];
      edge += Math.abs(px(63) - px(0));
      inside += Math.abs(px(32) - px(31));
    }
    // Across the tile's edge it changes no more than between two neighbours inside it (with room for the steps a pattern has).
    assert.ok(edge <= inside * 3 + 64 * 40, `${kind}: seam ${edge} vs ${inside}`);
    const colours = new Set<number>();
    for (let i = 0; i < a.rgba.length; i += 4) colours.add(a.rgba[i] << 16 | a.rgba[i + 1] << 8 | a.rgba[i + 2]);
    assert.ok(colours.size > 1, `${kind} is not one flat colour`);
  }
});

await test("a PNG it writes is a real PNG, and an image's bytes become a data URL only when they are PNG or JPEG", () => {
  const png = png2();
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  // IDAT inflates to the rows (a filter byte and four bytes a pixel).
  const at = Buffer.from(png).indexOf("IDAT");
  const len = new DataView(png.buffer).getUint32(at - 4);
  const rows = zlib.inflateSync(Buffer.from(png.subarray(at + 4, at + 4 + len)));
  assert.equal(rows.length, 2 * (1 + 2 * 4));
  assert.match(imageDataUrl(png)!, /^data:image\/png;base64,/);
  assert.match(imageDataUrl(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))!, /^data:image\/jpeg;base64,/);
  assert.equal(imageDataUrl(new Uint8Array([1, 2, 3, 4])), null);
});

await test("every shape has UVs (box projection), so a pattern or picture sits on any of them", () => {
  const g = new THREE.BoxGeometry(100, 100, 100).toNonIndexed();
  g.deleteAttribute("uv");
  addBoxUVs(its<Its<typeof addBoxUVs>[0]>(g));
  const uv = g.getAttribute("uv");
  assert.ok(uv);
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < uv.count; i++) { lo = Math.min(lo, uv.getX(i)); hi = Math.max(hi, uv.getX(i)); }
  assert.ok(Math.abs(hi - lo - 1) < 1e-6, "100 mm is one unit of UV");
});

await test("a picture from a file is laid on with its scale, and an outline shape's geometry carries UVs", async () => {
  const { e, id } = await fresh();
  const data = imageDataUrl(png2())!;
  await run(e, "surface_set", { id, image: data, imageScale: 50 });
  const b = bodyOf(e, id);
  assert.equal(b.surface!.image!.scale, 50);
  assert.ok(buildBodyGeometry(b)!.getAttribute("uv"));
  const summary = (await run(e, "scene_get", {})).shapes[0];
  assert.match(summary.surface, /image/);
  assert.equal((await e.execute("surface_set", { id, image: null })).ok, true);
  assert.equal(bodyOf(e, id).surface, undefined);
});

// -------------------------------------------------------------------- hair --

await test("hair grows seeded: the same settings grow the same strands, another seed others, and fur starts as a coat", async () => {
  const { e, id } = await fresh();
  const grown = await run(e, "hair_set", { id, length: 30 });
  assert.equal(grown.hair.style, "strands");
  const g = buildBodyGeometry(bodyOf(e, id))!;
  const a = growStrands(g, bodyOf(e, id).hair!);
  const b = growStrands(g, bodyOf(e, id).hair!);
  assert.ok(a.strands.length > 100);
  assert.deepEqual(a.strands[5].map((p) => p.toArray()), b.strands[5].map((p) => p.toArray()));
  const c = growStrands(g, { ...bodyOf(e, id).hair!, seed: 2 });
  assert.notDeepEqual(a.strands[5][0].toArray(), c.strands[5][0].toArray());
  await run(e, "hair_set", { id, style: "fur" });
  const fur = bodyOf(e, id).hair!;
  assert.equal(fur.style, "fur");
  assert.equal(fur.length, 8, "a coat's length");
  assert.ok(fur.density >= 40);
  assert.equal((await e.execute("hair_set", { id, curl: 2 })).ok, false);
  await run(e, "hair_set", { id, remove: true });
  assert.equal(bodyOf(e, id).hair, undefined);
});

await test("strands start on the surface, grow outward, and stay outside it; density past the cap spreads and widens them", async () => {
  const { e, id } = await fresh();
  await run(e, "hair_set", { id, length: 20, droop: 0, clump: 0, frizz: 0 });
  const g = buildBodyGeometry(bodyOf(e, id))!;
  const { strands, normals } = growStrands(g, bodyOf(e, id).hair!);
  strands.forEach((pts, i) => {
    const root = pts[0];
    // On the box: on one of its faces.
    const onFace = Math.abs(Math.abs(root.x) - 30) < 0.01 || Math.abs(root.y) < 0.01 || Math.abs(root.y - 30) < 0.01 || Math.abs(Math.abs(root.z) - 20) < 0.01;
    assert.ok(onFace, `root ${root.toArray()}`);
    const tip = pts[pts.length - 1];
    assert.ok(tip.clone().sub(root).dot(normals[i]) > 5, "grows out");
  });
  const big = buildBodyGeometry({ ...bodyOf(e, id), points: [{ x: -100, y: -100 }, { x: 100, y: -100 }, { x: 100, y: 100 }, { x: -100, y: 100 }], basePoints: undefined, extrusionHeight: 100 })!;
  const dense = growStrands(big, settleHair({ ...bodyOf(e, id).hair!, density: 80 }));
  assert.equal(dense.strands.length, MAX_STRANDS);
  assert.ok(dense.widen > 1);
});

await test("hair with droop falls: down and away from the middle, never back into the shape", async () => {
  const e = new Engine(emptyDoc());
  const id = ((await e.execute("sculpt_blend", { parts: [{ kind: "sphere", at: { x: 0, y: 0, z: 50 }, radius: 40 }] })).result as { id: string }).id;
  await run(e, "hair_set", { id, length: 60, droop: 0.8, clump: 0, frizz: 0 });
  const g = buildBodyGeometry(bodyOf(e, id))!;
  const { strands } = growStrands(g, bodyOf(e, id).hair!);
  let falling = 0;
  for (const pts of strands) {
    const root = pts[0];
    const tip = pts[pts.length - 1];
    if (root.y > 85 && tip.y < root.y) falling++;
    for (const q of pts.slice(1)) assert.ok(q.distanceTo(new THREE.Vector3(0, 50, 0)) > 39, "outside the head");
  }
  assert.ok(falling > 0, "hair from the crown falls");
});

await test("grooming: cut shortens and lengthen grows where the brush went, comb lays the hair its way, and none of it is the agent's", async () => {
  const { e, id } = await fresh();
  await run(e, "hair_set", { id, length: 20 });
  const top = { x: 0, y: 0, h: 30 };
  const at = new THREE.Vector3(top.x, top.h, -top.y);
  const up = new THREE.Vector3(0, 1, 0);
  const cut = groomer([{ tool: "cut", path: [0, 0, 30], radius: 10, strength: 1 }], 0)(its(at), its(up));
  assert.ok(cut.length < 0.3);
  const far = groomer([{ tool: "cut", path: [0, 0, 30], radius: 10, strength: 1 }], 0)(its(new THREE.Vector3(25, 30, 0)), its(up));
  assert.equal(far.length, 1, "outside the brush, untouched");
  assert.ok(groomer([{ tool: "lengthen", path: [0, 0, 30], radius: 10, strength: 1 }], 0)(its(at), its(up)).length > 1.5);
  const comb = groomer([{ tool: "comb", path: [-10, 0, 30, 10, 0, 30], radius: 10, strength: 1 }], 0)(its(at), its(up));
  assert.ok(comb.comb.x > 0.5 && Math.abs(comb.comb.y) < 1e-6, "laid along +x, never into the surface");
  // The agent may not groom; the person may, and their strokes stay when the agent changes the numbers.
  const refused = await e.execute("hair_groom", { id, stroke: { tool: "cut", path: [0, 0, 30], radius: 10, strength: 1 } });
  assert.equal(refused.ok, false);
  assert.match(refused.error!, /styling hair by hand is theirs/);
  const before = e.getDoc();
  const mine = await e.execute("hair_groom", { id, stroke: { tool: "cut", path: [0, 0, 30], radius: 10, strength: 1 } }, { who: "person" });
  assert.ok(mine.ok, mine.error);
  assert.match(describeEdit(before, e.getDoc()), /groomed the hair of Box/);
  await run(e, "hair_set", { id, curl: 0.5 });
  assert.equal(bodyOf(e, id).hair!.strokes!.length, 1, "the person's grooming stays");
  await run(e, "hair_set", { id, clearGrooming: true });
  assert.equal(bodyOf(e, id).hair!.strokes, undefined);
});

await test("hair is drawn as tapering ribbons coloured root to tip; fur as layers pushed out along the surface", async () => {
  const { e, id } = await fresh();
  await run(e, "hair_set", { id, length: 25, rootColor: "#000000", tipColor: "#ffffff" });
  const body = bodyOf(e, id);
  const g = buildBodyGeometry(body)!;
  const ribbons = hairGeometry(g, body.hair!)!;
  for (const attr of ["position", "normal", "tangent", "color", "uv"]) assert.ok(ribbons.getAttribute(attr), attr);
  const col = ribbons.getAttribute("color");
  const uv = ribbons.getAttribute("uv");
  for (let i = 0; i < 60; i++) {
    if (uv.getY(i) === 0) assert.ok(col.getX(i) < 0.01, "root is the root colour");
    if (uv.getY(i) === 1) assert.ok(col.getX(i) > 0.99, "tip is the tip colour");
  }
  const half = furShell(g, { ...body.hair!, style: "fur", droop: 0 }, 0.5).geometry.getAttribute("position");
  const base = g.getAttribute("position");
  const n = g.getAttribute("normal");
  const v = new THREE.Vector3();
  const w = new THREE.Vector3();
  v.fromBufferAttribute(its(half), 0).sub(w.fromBufferAttribute(its(base), 0));
  assert.ok(v.dot(new THREE.Vector3().fromBufferAttribute(its(n), 0)) > 5, "the middle layer stands off the skin");
});

await test("hair stays off a wall shape, and an STL never carries it", async () => {
  const { e, id } = await fresh();
  const wall = await e.execute("shape_draw", { form: "rectangle", from: { x: -10, y: -10 }, to: { x: 10, y: 10 }, surface: { wallOf: id, wall: 0 }, height: 5 });
  assert.ok(wall.ok, wall.error);
  const wid = (wall.result as { id: string }).id;
  assert.equal((await e.execute("hair_set", { id: wid })).ok, false);
  await run(e, "hair_set", { id });
  const plain = stlBytes([{ ...bodyOf(e, id), hair: undefined }])!;
  assert.equal(stlBytes([bodyOf(e, id)])!.length, plain.length);
});

// --------------------------------------------------------------- light --

await test("the light is the model's: set, kept through a save, described in the summary", async () => {
  const { e } = await fresh();
  assert.deepEqual(await run(e, "scene_look", { environment: "night", exposure: 1.4 }), { environment: "night", exposure: 1.4 });
  assert.equal((await e.execute("scene_look", { environment: "moon" })).ok, false);
  assert.equal((await e.execute("scene_look", { exposure: 9 })).ok, false);
  const again = parseDoc(JSON.parse(JSON.stringify(e.toJSON())))!;
  assert.deepEqual(again.look, { environment: "night", exposure: 1.4 });
  assert.equal((await run(e, "scene_get", {})).light.environment, "night");
});

// --------------------------------------------------------------- GLB --

await test("a GLB carries the finish as glTF PBR with the extensions engines read, the pattern as a picture, and the hair as its own node", async () => {
  const { e, id } = await fresh();
  await run(e, "surface_set", { id, preset: "glass", sheen: 0.4, clearcoat: 0.5, glow: 2, pattern: "marble" });
  await run(e, "hair_set", { id, length: 15 });
  const json = glbJson(glbBytes(e.getDoc().bodies, { groups: e.getDoc().groups })!);
  for (const ext of ["KHR_materials_transmission", "KHR_materials_ior", "KHR_materials_volume", "KHR_materials_sheen", "KHR_materials_clearcoat", "KHR_materials_emissive_strength"]) {
    assert.ok(json.extensionsUsed.includes(ext), ext);
  }
  assert.equal(json.images.length, 1);
  assert.equal(json.images[0].mimeType, "image/png");
  const solid = json.meshes.find((m: { name: string }) => m.name === "Box");
  assert.ok(solid.primitives[0].attributes.TEXCOORD_0 !== undefined);
  const hair = json.meshes.find((m: { name: string }) => m.name === "Box_hair");
  assert.ok(hair.primitives[0].attributes.COLOR_0 !== undefined);
  const boxNode = json.nodes.findIndex((n: { name: string }) => n.name === "Box");
  const hairNode = json.nodes.findIndex((n: { name: string }) => n.name === "Box_hair");
  assert.ok(json.nodes[boxNode].children.includes(hairNode), "the hair hangs off its shape");
  assert.equal(json.scenes[0].nodes.includes(hairNode), false);
  assert.equal(json.materials[json.meshes[json.nodes[hairNode].mesh].primitives[0].material].doubleSided, true);
});

await test("a GLB with a picture comes back in with its picture and its layout", async () => {
  const { e, id } = await fresh();
  await run(e, "surface_set", { id, image: imageDataUrl(png2())! });
  const glb = glbBytes(e.getDoc().bodies)!;
  const raw = readMesh(glb, "glb");
  assert.ok(raw.uvs, "the layout came back");
  assert.match(raw.image!, /^data:image\/png;base64,/);
  const placed = placeMesh(raw, "glb");
  assert.ok(placed.mesh.uvs && placed.mesh.uvs.length / 2 === placed.mesh.positions.length / 3);
  const back = new Engine(emptyDoc());
  const res = await back.execute("mesh_import", { data: Buffer.from(glb).toString("base64"), name: "box.glb" });
  assert.ok(res.ok, res.error);
  const made = back.getDoc().bodies[0] as Body3D;
  assert.ok(made.surface?.image, "the picture is on the shape");
  assert.equal(made.color, "#ffffff", "nothing tints it");
  assert.match((res.result as { note: string }).note, /picture/);
  // Moving and resizing keep the layout; subdividing (new vertices) lets it go.
  await back.execute("shape_move", { ids: [made.id], by: { x: 10 } });
  await back.execute("shape_resize", { id: made.id, width: 120 });
  assert.ok(back.getDoc().bodies[0].mesh!.uvs);
  await back.execute("sculpt_smooth", { id: made.id, subdivide: 1, passes: 0 });
  assert.equal(back.getDoc().bodies[0].mesh!.uvs, undefined);
});

// --------------------------------------------- relief, roughness, mirror, resting --

await test("relief and roughness pictures: set, sized, given a strength, kept by a preset, taken off; a GLB carries roughness on a non-metal", async () => {
  const { e, id } = await fresh();
  const pic = imageDataUrl(png2())!;
  await run(e, "surface_set", { id, image: pic, imageScale: 40, reliefImage: pic, reliefStrength: 0.8, roughnessImage: pic, roughnessScale: 20 });
  let s = bodyOf(e, id).surface!;
  assert.equal(s.reliefImage!.strength, 0.8);
  assert.equal(s.roughnessImage!.scale, 20);
  assert.equal((await e.execute("surface_set", { id, reliefStrength: 2 })).ok, false);
  await run(e, "surface_set", { id, preset: "rubber" });
  s = bodyOf(e, id).surface!;
  assert.ok(s.reliefImage && s.roughnessImage && s.image, "a preset keeps the pictures");
  const json = glbJson(glbBytes(e.getDoc().bodies)!);
  const mat = json.materials[0];
  assert.ok(mat.pbrMetallicRoughness.metallicRoughnessTexture, "roughness picture on a non-metal");
  assert.deepEqual(mat.pbrMetallicRoughness.metallicRoughnessTexture.extensions.KHR_texture_transform.scale, [2, 2], "its own repeat on the colour picture's UVs");
  assert.ok(json.extensionsUsed.includes("KHR_texture_transform"));
  await run(e, "surface_set", { id, preset: "metal" });
  assert.equal(glbJson(glbBytes(e.getDoc().bodies)!).materials[0].pbrMetallicRoughness.metallicRoughnessTexture, undefined, "not on a metal: glTF would read its metalness from it");
  await run(e, "surface_set", { id, reliefImage: null, roughnessImage: null });
  s = bodyOf(e, id).surface!;
  assert.equal(s.reliefImage, undefined);
  assert.equal(s.roughnessImage, undefined);
  assert.ok(s.image);
  assert.equal((await e.execute("surface_set", { id, reliefStrength: 0.5 })).ok, false, "no relief picture to strengthen");
});

await test("a mirrored grooming stroke is made on both sides, in one command", async () => {
  const { e, id } = await fresh();
  await run(e, "hair_set", { id });
  const done = await e.execute("hair_groom", { id, mirror: "x", stroke: { tool: "comb", path: [10, 5, 30, 20, 5, 30], radius: 8, strength: 1 } }, { who: "person" });
  assert.ok(done.ok, done.error);
  const strokes = bodyOf(e, id).hair!.strokes!;
  assert.equal(strokes.length, 2);
  assert.deepEqual(strokes[1].path, [-10, 5, 30, -20, 5, 30], "reflected across the box's middle, left to right");
  assert.equal(e.commandLog().filter((c) => c.name === "hair_groom").length, 1, "one command, one undo step");
  assert.equal((await e.execute("hair_groom", { id, mirror: "z", stroke: strokes[0] }, { who: "person" })).ok, false);
});

await test("hair rests on the shapes it falls onto instead of passing through them", async () => {
  const e = new Engine(emptyDoc());
  const head = ((await e.execute("sculpt_blend", { parts: [{ kind: "sphere", at: { x: 0, y: 0, z: 110 }, radius: 30 }] })).result as { id: string }).id;
  await e.execute("shape_add", { kind: "box", x: 0, y: 0, width: 200, depth: 200, height: 70, name: "Table" });
  await run(e, "hair_set", { id: head, length: 120, droop: 1, clump: 0, frizz: 0 });
  const g = buildBodyGeometry(bodyOf(e, head))!;
  const table = e.getDoc().bodies.find((b) => b.name === "Table")!;
  const tg = buildBodyGeometry(table)!;
  tg.computeBoundingBox();
  const free = growStrands(g, bodyOf(e, head).hair!);
  const resting = growStrands(g, bodyOf(e, head).hair!, 0, undefined, undefined, [{ box: tg.boundingBox! as never, round: false }]);
  const below = (st: typeof free) => st.strands.flat().filter((p) => p.y < 69.9 && Math.abs(p.x) < 99 && Math.abs(p.z) < 99).length;
  assert.ok(below(free) > 0, "without it the hair falls into the table");
  assert.equal(below(resting), 0, "with it the hair lies on top");
});

// ----------------------------------------------------------- Panacea --

await test("Panacea's 3D panels read the modeller's own numbers for every finish, and set surfaces, hair and light with its tools", async () => {
  assert.deepEqual([...MATERIALS], MATERIAL_PRESETS.map((p) => p.id));
  assert.deepEqual([...PANEL_PATTERNS].sort(), [...PATTERN_KINDS].sort());
  for (const k of Object.keys(HAIR_START) as (keyof typeof HAIR_START)[]) assert.equal(HAIR_START[k], DEFAULT_HAIR[k], `hair ${k}`);
  for (const p of MATERIAL_PRESETS) {
    const r = resolveSurface({ materialType: p.id, color: p.color });
    const f = FINISH_OF[p.id];
    for (const k of ["roughness", "metalness", "transmission", "ior", "opacity", "sheen", "subsurface", "glow"] as const) assert.equal(f[k], r[k], `${p.id}.${k}`);
  }
  const { e, id } = await fresh();
  const doc = () => e.getDoc() as unknown as ModelDoc;
  const apply = async (bind: string, v: unknown) => {
    const plan = modelCommands(doc(), bind, v as never, id);
    assert.ok(!("error" in plan), `${bind}: ${"error" in plan ? plan.error : ""}`);
    for (const c of plan.commands) await run(e, c.tool, c.args);
  };
  assert.equal(readModel(doc(), "model.roughness", id), 0.8);
  await apply("model.material", "glass");
  assert.equal(readModel(doc(), "model.clear", id), 0.8);
  await apply("model.roughness", 0.35);
  assert.equal(readModel(doc(), "model.roughness", id), 0.35);
  assert.ok("error" in modelCommands(doc(), "model.relief", 0.5, id), "a pattern first");
  await apply("model.pattern", "scales");
  await apply("model.relief", 0.6);
  assert.equal(readModel(doc(), "model.relief", id), 0.6);
  assert.equal(readModel(doc(), "model.hair", id), false);
  assert.ok("error" in modelCommands(doc(), "model.hairlength", 50, id), "hair first");
  await apply("model.hair", true);
  await apply("model.hairlength", 55);
  await apply("model.haircolor", "#aa5500");
  assert.equal(readModel(doc(), "model.hairlength", id), 55);
  assert.equal(readModel(doc(), "model.haircolor", id), "#aa5500");
  await apply("model.light", "sunset");
  assert.equal(readModel({ bodies: [], look: e.getDoc().look }, "model.light"), "sunset", "the light needs no part");
  assert.ok("error" in modelCommands(doc(), "model.light", "moon"));
  await apply("model.hair", false);
  assert.equal(readModel(doc(), "model.hair", id), false);
});

console.log(`surface-3d: ${passed} passed, 0 failed`);
