/**
 * Autora 3D brings in a mesh (GLB, OBJ, STL) as one shape: the parsers, the placement, the editing that still applies,
 * and the agent's cad_mesh_import with the file named rather than sent.
 *
 * Needs the modeller's engine built (`npm --prefix autora-3d run build:engine`).
 *
 *   npx tsx tests/mesh-import.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { meshFormatOf, placeMesh, readMesh, simplify } from "../autora-3d/src/utils/meshImport";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autora-mesh-"));
process.env.AUTORA_STATE_DIR = dir;

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

// A unit box, 12 triangles, outward-facing.
const V = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];
const F = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
const scaled = (k: number) => V.map(([x, y, z]) => [x * k * 2, y * k, z * k * 0.5]);

function objOf(k: number): Buffer {
  return Buffer.from(scaled(k).map((v) => `v ${v.join(" ")}`).join("\n") + "\n" + F.map((f) => `f ${f.map((i) => i + 1).join(" ")}`).join("\n") + "\n");
}
function stlBinary(k: number): Buffer {
  const out = Buffer.alloc(84 + F.length * 50);
  out.writeUInt32LE(F.length, 80);
  F.forEach((f, t) => f.forEach((i, c) => scaled(k)[i].forEach((n, a) => out.writeFloatLE(n, 84 + t * 50 + 12 + (c * 3 + a) * 4))));
  return out;
}
function stlAscii(k: number): Buffer {
  return Buffer.from("solid x\n" + F.map((f) => `facet normal 0 0 0\nouter loop\n${f.map((i) => `vertex ${scaled(k)[i].join(" ")}`).join("\n")}\nendloop\nendfacet`).join("\n") + "\nendsolid x\n");
}
/** A GLB with the box under a parent node that moves and scales it (metres), as a CC0 model would be. */
function glbOf(opts: { rgba?: number[]; indexType?: 5123 | 5125 } = {}): Buffer {
  const pos = Buffer.alloc(8 * 12);
  V.forEach((v, i) => v.forEach((n, a) => pos.writeFloatLE(n, i * 12 + a * 4)));
  const wide = opts.indexType === 5125;
  const idx = Buffer.alloc(F.length * 3 * (wide ? 4 : 2));
  F.flat().forEach((n, i) => (wide ? idx.writeUInt32LE(n, i * 4) : idx.writeUInt16LE(n, i * 2)));
  const idxPad = Buffer.alloc((4 - (idx.length % 4)) % 4);
  const bin = Buffer.concat([pos, idx, idxPad]);
  const json = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ children: [1], translation: [5, 0, 0], scale: [2, 1, 0.5] }, { mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: opts.rgba ?? [1, 1, 1, 1] } }],
    buffers: [{ byteLength: bin.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: pos.length }, { buffer: 0, byteOffset: pos.length, byteLength: idx.length }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 8, type: "VEC3" },
      { bufferView: 1, componentType: wide ? 5125 : 5123, count: F.length * 3, type: "SCALAR" },
    ],
  };
  let text = JSON.stringify(json);
  text += " ".repeat((4 - (text.length % 4)) % 4);
  const jsonChunk = Buffer.from(text);
  const total = 12 + 8 + jsonChunk.length + 8 + bin.length;
  const head = Buffer.alloc(12);
  head.write("glTF", 0);
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(total, 8);
  const c1 = Buffer.alloc(8);
  c1.writeUInt32LE(jsonChunk.length, 0);
  c1.writeUInt32LE(0x4e4f534a, 4);
  const c2 = Buffer.alloc(8);
  c2.writeUInt32LE(bin.length, 0);
  c2.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([head, c1, jsonChunk, c2, bin]);
}

// ------------------------------------------------------------------ parsers --

await test("each format is read into the same box", () => {
  for (const [format, data] of [["obj", objOf(1)], ["stl", stlBinary(1)], ["stl", stlAscii(1)], ["glb", glbOf()], ["glb", glbOf({ indexType: 5125 })]] as const) {
    const m = readMesh(data, format);
    assert.equal(m.indices.length / 3, 12, `${format} triangles`);
    assert.equal(m.positions.length / 3, 8, `${format} welded vertices`);
  }
});

await test("a glTF node's translation and scale are applied", () => {
  const m = readMesh(glbOf(), "glb");
  const xs = m.positions.filter((_, i) => i % 3 === 0);
  const zs = m.positions.filter((_, i) => i % 3 === 2);
  assert.deepEqual([Math.min(...xs), Math.max(...xs)], [5, 7]);
  assert.deepEqual([Math.min(...zs), Math.max(...zs)], [0, 0.5]);
});

await test("a glTF base colour becomes the shape's colour; the format is told from the name or the bytes", () => {
  assert.equal(readMesh(glbOf({ rgba: [1, 0, 0, 1] }), "glb").color, "#ff0000");
  assert.equal(meshFormatOf("Horse.GLB"), "glb");
  assert.equal(meshFormatOf("thing", glbOf()), "glb");
  assert.equal(meshFormatOf("thing", stlAscii(1)), "stl");
  assert.equal(meshFormatOf("thing", objOf(1)), "obj");
  assert.equal(meshFormatOf("part.step"), null);
});

await test("a file that is not a mesh is refused in words", () => {
  assert.throws(() => readMesh(Buffer.from("hello there, this is text"), "stl"), /STL/);
  assert.throws(() => readMesh(Buffer.from("not json"), "glb"), /GLB or glTF/);
  assert.throws(() => readMesh(Buffer.from("v 0 0 0\nf 1 2 3\n"), "obj"), /vertex it does not have/);
  assert.throws(() => readMesh(Buffer.from("# nothing\n"), "obj"), /no triangles/);
});

await test("a mesh over the limit is simplified and keeps its extent", () => {
  const n = 200;
  const positions: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) positions.push(i, j, Math.sin(i / 9) * 3);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const a = i * (n + 1) + j;
    indices.push(a, a + 1, a + n + 1, a + 1, a + n + 2, a + n + 1);
  }
  const out = simplify({ positions, indices }, 5000);
  assert.ok(out.indices.length / 3 <= 5000 && out.indices.length / 3 > 500, `${out.indices.length / 3}`);
  const xs = out.positions.filter((_, i) => i % 3 === 0);
  assert.ok(Math.max(...xs) - Math.min(...xs) > n * 0.9);
});

await test("placement: units, up axis, size, and standing on the ground", () => {
  // A GLB is in metres, Y up: the box (2 x 1 x 0.5 m) is 2000 x 500 (depth) x 1000 (height) mm, then fitted down to a speck-free size.
  const g = placeMesh(readMesh(glbOf(), "glb"), "glb", { size: 240 });
  assert.equal(g.height, 120); // the box is 2 wide, 1 high (y), 0.5 deep: 240 mm wide -> 120 high
  const w = g.points[1].x - g.points[0].x;
  const d = g.points[2].y - g.points[1].y;
  assert.equal(Math.round(w), 240);
  assert.equal(Math.round(d), 60);
  assert.equal(Math.min(...g.mesh.positions.filter((_, i) => i % 3 === 2)), 0);
  // STL is Z up and in mm: the same box stays 2 x 1 x 0.5 mm, which is a speck, so it is fitted to 100 mm.
  const s = placeMesh(readMesh(stlBinary(1), "stl"), "stl", {});
  assert.equal(Math.round(s.points[1].x - s.points[0].x), 100);
  assert.equal(Math.round(s.height), 25);
  const lying = placeMesh(readMesh(stlBinary(1), "stl"), "stl", { up: "y", size: 100 });
  assert.equal(Math.round(lying.height), 50, "up:y reads the file's y (1) as the height");
});

// ------------------------------------------------------------------ the engine --

const cad = await import("../server/caddesk");
assert.ok(cad.cadAvailable(), "the modeller is not built: run `npm --prefix autora-3d run build` first");
const core = await import(new URL("../dist/autora-3d-engine/engine.mjs", import.meta.url).href);
await core.initManifold();
const b64 = (b: Buffer) => b.toString("base64");

await test("mesh_import adds one mesh shape that the rest of the modeller can move, turn, resize and measure", async () => {
  const e = new core.Engine(core.emptyDoc());
  const added = await e.execute("shape_add", { kind: "box", width: 40, depth: 40, height: 10, x: 0, y: 0 });
  assert.ok(added.ok);
  const r = await e.execute("mesh_import", { data: b64(glbOf()), name: "Horse.glb", size: 240 });
  assert.ok(r.ok, JSON.stringify(r));
  const id = (r.result as { id: string }).id;
  const doc = e.getDoc();
  const body = doc.bodies.find((x: { id: string }) => x.id === id);
  assert.equal(body.name, "Horse");
  assert.equal(body.mesh.indices.length / 3, 12);
  const beside = Math.min(...body.points.map((p: { x: number }) => p.x));
  assert.ok(beside >= 20 + 49, `it lands beside the existing shape, not on it: left edge ${beside}`);

  const before = Math.min(...body.mesh.positions.filter((_: number, i: number) => i % 3 === 0));
  assert.ok((await e.execute("shape_move", { ids: [id], by: { x: 100, z: 5 } })).ok);
  const moved = e.getDoc().bodies.find((x: { id: string }) => x.id === id);
  assert.ok(Math.abs(Math.min(...moved.mesh.positions.filter((_: number, i: number) => i % 3 === 0)) - (before + 100)) < 0.05);
  assert.equal(moved.elevation, 5);

  assert.ok((await e.execute("shape_turn", { ids: [id], degrees: 90 })).ok);
  const turned = e.getDoc().bodies.find((x: { id: string }) => x.id === id);
  const ext = (b: any, axis: number) => { const v = b.mesh.positions.filter((_: number, i: number) => i % 3 === axis); return Math.max(...v) - Math.min(...v); };
  assert.ok(Math.abs(ext(turned, 1) - 240) < 0.1 && Math.abs(ext(turned, 0) - 60) < 0.1, "a quarter turn swaps its width and depth");

  assert.ok((await e.execute("shape_resize", { id, height: 60 })).ok);
  const smaller = e.getDoc().bodies.find((x: { id: string }) => x.id === id);
  assert.equal(smaller.extrusionHeight, 60);
  assert.ok(Math.abs(ext(smaller, 2) - 60) < 0.01, "the mesh's own height follows");

  const m = await e.execute("shape_measure", { id });
  assert.ok(m.ok && (m.result as { watertight: boolean }).watertight, JSON.stringify(m));
  const got = await e.execute("scene_get", {});
  assert.ok(JSON.stringify(got.result).includes('"triangles":12'));
});

await test("a mesh has no outline to edit, and says so", async () => {
  const e = new core.Engine(core.emptyDoc());
  const id = ((await e.execute("mesh_import", { data: b64(objOf(10)), name: "a.obj", size: 50 })).result as { id: string }).id;
  for (const [tool, args] of [["edge_bevel", { id, group: "top", size: 1, style: "round" }], ["face_push", { id, face: "top", by: 2 }], ["shape_set", { id, cornerRadius: 3 }]] as const) {
    const r = await e.execute(tool, args);
    assert.ok(!r.ok && /mesh brought in from a file/.test(r.error ?? ""), `${tool}: ${r.error}`);
  }
  const bad = await e.execute("mesh_import", { data: b64(Buffer.from("junk")), name: "x.stl" });
  assert.ok(!bad.ok && /STL/.test(bad.error ?? ""));
  const none = await e.execute("mesh_import", { name: "x.stl" });
  assert.ok(!none.ok);
});

await test("a mesh exports with the rest of the model, but is not joined or cut as an outline", async () => {
  const e = new core.Engine(core.emptyDoc());
  const id = ((await e.execute("mesh_import", { data: b64(stlBinary(10)), name: "a.stl", size: 50 })).result as { id: string }).id;
  const other = ((await e.execute("shape_add", { kind: "box", width: 20, depth: 20, height: 20 })).result as { id: string }).id;
  const joined = await e.execute("shapes_join", { ids: [id, other] });
  assert.ok(!joined.ok && /mesh brought in from a file/.test(joined.error ?? ""), joined.error);
  assert.ok((await e.execute("group_create", { ids: [id, other], name: "Pair" })).ok);
  const out = await e.execute("export", { format: "glb" });
  assert.ok(out.ok && (out.result as { bytes: number }).bytes > 200);
  const stl = await e.execute("export", { format: "stl" });
  assert.ok(stl.ok);
  assert.ok(id);
});

// ------------------------------------------------------------------ the agent's tool and the Load button --

await test("cad_mesh_import reads a named file; Load adds a mesh to what is there", async () => {
  const file = path.join(dir, "Horse.glb");
  fs.writeFileSync(file, glbOf());
  const session = "mesh-session";
  cad.__testSession?.(session);
  const out = await cad.runCadTool(session, "cad_mesh_import", { file: "Horse.glb", size: 240 }, { cwd: dir });
  assert.ok(out.ok, out.summary);
  assert.match(out.summary, /"triangles":12/);
  assert.equal(cad.cadState(session).shapes, 1);
  const missing = await cad.runCadTool(session, "cad_mesh_import", { file: "Nope.glb" }, { cwd: dir });
  assert.ok(!missing.ok && /Nope\.glb/.test(missing.summary));
  const loaded = await cad.loadModel(session, objOf(5), "Second.obj");
  assert.ok(loaded.ok, loaded.error);
  assert.equal(loaded.shapes, 2, "Load added it and kept the first");
  const bad = await cad.loadModel(session, Buffer.from("junk"), "x.stl");
  assert.ok(!bad.ok && /STL/.test(bad.error ?? ""));
});

console.log(`\n${passed} passed`);
