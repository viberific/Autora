/**
 * What keeps Autora 3D's surfaces, hair and their panels light: a picture travels once (the window saves it by key, the
 * server puts it back, and refuses a key it does not hold so the window sends it whole), the engine keeps one copy of a
 * picture however many models hold it, hair shares one strand budget and a file's hair is capped, and Panacea offers the
 * 3D panel that helps next when a 3D value goes somewhere telling.
 *
 * Needs the modeller built (`npm --prefix autora-3d run build`) for the route tests.
 *
 *   npx tsx tests/cad-pictures.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AUTORA_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "autora-cad-pictures-"));

const { byReference, isPictureKey, pictureKey, picturesOf, restorePictures } = await import("../src/lib/cadPictures");
const { Engine } = await import("../autora-3d/src/core/engine");
const { emptyDoc, parseDoc } = await import("../autora-3d/src/core/doc");
const { encodePng, imageDataUrl, sharePictures } = await import("../autora-3d/src/utils/surface");
const { buildBodyGeometry } = await import("../autora-3d/src/utils/bodyGeometry");
const { furLayers, growStrands, EXPORT_STRANDS, FUR_VERTICES } = await import("../autora-3d/src/utils/hair");
const { glbBytes } = await import("../autora-3d/src/utils/glb");
const { thumbnailSvg } = await import("../autora-3d/src/utils/thumbnail");
const { newCanvas } = await import("../src/lib/panacea/canvas");
const { BUILTINS } = await import("../src/lib/panacea/library");
const { placeRecipe, suggestForApp } = await import("../src/lib/panacea/rules");

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

const picture = (seed: number) => imageDataUrl(encodePng(64, 64, new Uint8Array(64 * 64 * 4).map((_, i) => (i * seed) & 255)))!;
const model = async (pic?: string) => {
  const e = new Engine(emptyDoc());
  const r = await e.execute("shape_add", { kind: "box", width: 60, depth: 40, height: 30, name: "Box" });
  const id = (r.result as { id: string }).id;
  if (pic) assert.ok((await e.execute("surface_set", { id, image: pic })).ok);
  return { e, id };
};

await test("a picture is sent by its key when the server holds it, and put back whole; an unknown key is named", async () => {
  const pic = picture(3);
  const { e } = await model(pic);
  const doc = e.toJSON();
  const key = pictureKey(pic);
  assert.ok(isPictureKey(key));
  assert.equal(pictureKey(pic), key, "the same picture, the same key");
  assert.notEqual(pictureKey(picture(5)), key);
  assert.deepEqual([...picturesOf(doc).keys()], [key]);
  const first = byReference(doc, new Set());
  assert.deepEqual(first.sent, [key], "not held yet: sent whole");
  const slim = byReference(doc, new Set([key]));
  assert.deepEqual(slim.sent, []);
  assert.equal(slim.doc.bodies[0].surface!.image!.data, key);
  assert.ok(JSON.stringify(slim.doc).length < 2000, "the save is small");
  const back = restorePictures(slim.doc, picturesOf(doc));
  assert.deepEqual(back.missing, []);
  assert.equal(back.doc.bodies[0].surface!.image!.data, pic);
  assert.deepEqual(restorePictures(slim.doc, new Map()).missing, [key]);
});

await test("relief and roughness pictures travel by key too", async () => {
  const pic = picture(17);
  const { e, id } = await model();
  assert.ok((await e.execute("surface_set", { id, reliefImage: pic, roughnessImage: pic })).ok);
  const doc = e.toJSON();
  const key = pictureKey(pic);
  const slim = byReference(doc, new Set([key]));
  assert.equal(slim.doc.bodies[0].surface!.reliefImage!.data, key);
  assert.equal(slim.doc.bodies[0].surface!.roughnessImage!.data, key);
  const back = restorePictures(slim.doc, picturesOf(doc));
  assert.equal(back.doc.bodies[0].surface!.reliefImage!.data, pic);
});

await test("the engine keeps one copy of a picture, however many models hold it", async () => {
  const pic = picture(7);
  const a = parseDoc(JSON.parse(JSON.stringify((await model(pic)).e.toJSON())))!;
  const b = parseDoc(JSON.parse(JSON.stringify((await model(pic)).e.toJSON())))!;
  // Two separate parses of the same text: the second is pointed at the first's copy (a new image record), and settling it
  // again changes nothing (each record is looked at once). Strings cannot be told apart by identity, so the records are.
  assert.equal(a.bodies[0].surface!.image!.data, b.bodies[0].surface!.image!.data);
  const fresh = JSON.parse(JSON.stringify(b.bodies));
  const once = sharePictures(fresh);
  assert.notEqual(once, fresh, "a copy that arrived again is replaced by the kept one");
  assert.equal(sharePictures(once), once, "and then left alone");
  const other = parseDoc(JSON.parse(JSON.stringify((await model(picture(11))).e.toJSON())))!;
  assert.notEqual(other.bodies[0].surface!.image!.data, a.bodies[0].surface!.image!.data, "a different picture stays itself");
});

await test("hair shares a strand budget; fur keeps its layers to a vertex budget; a GLB caps hair and can leave it out", async () => {
  const { e, id } = await model();
  assert.ok((await e.execute("hair_set", { id, density: 80, length: 20 })).ok);
  const body = e.getDoc().bodies[0];
  const g = buildBodyGeometry(body)!;
  assert.equal(growStrands(g, body.hair!, 0, undefined, 300).strands.length, 300, "a share of the scene's budget");
  assert.ok(furLayers(100) <= 16 && furLayers(1_000_000) >= 4);
  assert.ok(furLayers(20000) * 20000 * 3 <= FUR_VERTICES);
  const json = (glb: Uint8Array) => JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + new DataView(glb.buffer, glb.byteOffset).getUint32(12, true))));
  const big = { ...body, points: [{ x: -150, y: -150 }, { x: 150, y: -150 }, { x: 150, y: 150 }, { x: -150, y: 150 }], basePoints: undefined, extrusionHeight: 150 };
  const withHair = json(glbBytes([big])!);
  const hairMesh = withHair.meshes.find((m: { name: string }) => m.name === "Box_hair");
  const verts = withHair.accessors[hairMesh.primitives[0].attributes.POSITION].count;
  const per = verts / EXPORT_STRANDS;
  assert.ok(Number.isInteger(per) && per >= 2, `hair capped at ${EXPORT_STRANDS} strands (${verts} vertices)`);
  const without = json(glbBytes([big], { hair: false })!);
  assert.equal(without.meshes.some((m: { name: string }) => m.name === "Box_hair"), false);
  const exported = await e.execute("export", { format: "glb", hair: false });
  assert.ok(exported.ok);
});

await test("thumbnails show glass as see-through, a pattern's colours and hair as a soft edge", async () => {
  const { e, id } = await model();
  const plain = thumbnailSvg(e.getDoc().bodies);
  assert.doesNotMatch(plain, /fill-opacity/);
  await e.execute("surface_set", { id, preset: "glass" });
  assert.match(thumbnailSvg(e.getDoc().bodies), /fill-opacity="0\.\d+"/);
  await e.execute("hair_set", { id, tipColor: "#ffcc00" });
  assert.match(thumbnailSvg(e.getDoc().bodies), /stroke="#ffcc00"/);
});

await test("Panacea offers the 3D panel that helps next, beside the panel that changed it, once", () => {
  const canvas = newCanvas();
  const material = placeRecipe(canvas, BUILTINS.find((r) => r.id === "3d.material")!, { why: "test", by: "agent" });
  assert.ok(!("error" in material));
  const near = material.id;
  const none = () => false;
  assert.equal(suggestForApp(canvas, "model.material", "glass", near, none)?.recipe, "3d.glass");
  assert.equal(suggestForApp(canvas, "model.material", "metal", near, none), null, "metal is not telling");
  assert.equal(suggestForApp(canvas, "model.pattern", "wood", near, none)?.recipe, "3d.texture");
  assert.equal(suggestForApp(canvas, "model.pattern", "none", near, none), null);
  assert.equal(suggestForApp(canvas, "model.hair", true, near, none)?.recipe, "3d.hair");
  assert.equal(suggestForApp(canvas, "model.hair", true, null, none), null, "no panel to put it beside");
  assert.equal(suggestForApp(canvas, "model.hair", true, near, (r) => r === "3d.hair"), null, "waved away");
  placeRecipe(canvas, BUILTINS.find((r) => r.id === "3d.hair")!, { why: "test", by: "agent" });
  assert.equal(suggestForApp(canvas, "model.hair", true, near, none), null, "already on the canvas");
});

// ---------------------------------------------------------------- the route --

const cad = await import("../server/caddesk");
if (!cad.cadAvailable()) {
  console.log("  skip  the route: the modeller is not built (npm --prefix autora-3d run build)");
} else {
  const express = (await import("express")).default;
  const S = "pictures1";
  const app = express();
  cad.cadRoutes(app, { exists: (x) => x === S, incognito: () => false, off: () => false });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(base + url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  };
  try {
    await test("the server takes a picture by its key once it holds it, and asks for it whole when it does not", async () => {
      const pic = picture(13);
      const { e } = await model(pic);
      const doc = e.toJSON();
      const key = pictureKey(pic);
      const unknown = await call("PUT", `/api/cad/${S}/doc`, { doc: byReference(doc, new Set([key])).doc });
      assert.equal(unknown.status, 409);
      assert.deepEqual(unknown.body.missing, [key]);
      assert.equal((await call("PUT", `/api/cad/${S}/doc`, { doc })).status, 200, "sent whole");
      const renamed = byReference({ ...doc, bodies: doc.bodies.map((b) => ({ ...b, name: "Crate" })) }, new Set([key]));
      const small = await call("PUT", `/api/cad/${S}/doc`, { doc: renamed.doc });
      assert.equal(small.status, 200, JSON.stringify(small.body));
      const got = (await call("GET", `/api/cad/${S}/doc`)).body.doc;
      assert.equal(got.bodies[0].name, "Crate");
      assert.equal(got.bodies[0].surface.image.data, pic, "the picture is whole on the server");
    });
  } finally {
    server.close();
  }
}

console.log(`cad-pictures: ${passed} passed, 0 failed`);
