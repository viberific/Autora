/**
 * Panacea's 3D panels (docs/PANACEA-GAPS.md, G1): a `model.*` control reads the model in Autora 3D and runs the
 * modeller's own tools to change it. The pure adapter (reads, the commands a value makes, refusals), the route a panel's
 * change goes through (it changes the model, opens the window, refuses when 3D is off), the agent's panacea_set, and the
 * recipes (each wired, none a placebo).
 *
 * Needs the modeller built (`npm --prefix autora-3d run build`).
 *
 *   npx tsx tests/panacea-model.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AUTORA_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "autora-panacea-model-"));

const express = (await import("express")).default;
const cad = await import("../server/caddesk");
if (!cad.cadAvailable()) { console.log("  skip  the modeller is not built (npm --prefix autora-3d run build)"); process.exit(0); }
const model = await import("../src/lib/panacea/apps/model");
const { BUILTINS } = await import("../src/lib/panacea/library");
const { treeLive, unwiredBinds } = await import("../src/lib/panacea/wiring");
const panacea = await import("../server/panacea");

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

const S = "panelmodel1";
let off = false;
const app = express();
cad.cadRoutes(app, { exists: (id) => id === S, incognito: () => false, off: () => off });
const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const call = async (method: string, url: string, body?: unknown) => {
  const res = await fetch(base + url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
};
const doc = async () => (await call("GET", `/api/cad/${S}/doc`)).body.doc as import("../src/lib/panacea/apps/model").ModelDoc;
const tool = async (name: string, args: Record<string, unknown>) => { const r = await cad.runCadTool(S, name, args); assert.ok(r.ok, r.summary); };

await tool("cad_shape_add", { kind: "box", x: 0, y: 0, width: 40, depth: 20, height: 10, name: "Base" });
await tool("cad_shape_add", { kind: "cylinder", x: 100, y: 50, width: 30, depth: 30, height: 25, name: "Post" });

// ------------------------------------------------------------- the adapter --

await test("what a control shows is read off the part it acts on: the picked one, else the first", async () => {
  const d = await doc();
  const [base1, post] = model.modelParts(d);
  assert.equal(model.readModel(d, "model.part"), base1!.id);
  assert.equal(model.readModel(d, "model.width"), 40);
  assert.equal(model.readModel(d, "model.height", post!.id), 25);
  assert.equal(model.readModel(d, "model.x", post!.id), 100);
  assert.equal(model.readModel(d, "model.y", post!.id), 50);
  assert.equal(model.readModel(d, "model.z", post!.id), 0);
  assert.equal(model.readModel(d, "model.visible"), true);
  assert.equal(model.readModel(d, "model.bevel"), 0);
  assert.equal(model.readModel(d, "model.count"), 1);
  assert.equal(model.readModel(d, "model.part", "nope"), base1!.id, "a part that is gone falls back to the first");
  assert.deepEqual(model.modelOptions(d).map((o) => o.label), ["Base", "Post"]);
  assert.equal(model.readModel({ bodies: [] }, "model.x"), undefined, "no parts, nothing to show");
});

await test("a value that does not fit is refused with a reason, and makes no command", async () => {
  const d = await doc();
  for (const [bind, v] of [["model.x", "far"], ["model.width", 0], ["model.color", "blue"], ["model.material", "wood"], ["model.bevel", -1], ["model.bevelstyle", "soft"], ["model.gap", 10], ["model.count", 0], ["model.nope", 1]] as const) {
    assert.ok("error" in model.modelCommands(d, bind, v as never), bind);
  }
  assert.ok("error" in model.modelCommands({ bodies: [] }, "model.x", 5), "no parts");
});

// ----------------------------------------------------------------- recipes --

await test("every 3D recipe is wired: it is offered, and each of its binds is something the model answers to", () => {
  const recipes = BUILTINS.filter((r) => r.domain === "3d");
  assert.ok(recipes.length >= 7);
  for (const r of recipes) {
    assert.equal(treeLive(r.tree), true, `${r.id}: ${unwiredBinds(r.tree).join(", ")}`);
    const walk = (n: { bind?: string; children?: unknown[] }) => {
      if (n.bind?.startsWith("model.")) assert.ok(model.MODEL_WIRED.includes(n.bind), `${r.id}: ${n.bind}`);
      (n.children as typeof n[] | undefined)?.forEach(walk);
    };
    walk(r.tree);
  }
  for (const gone of ["rotate", "camera", "modifier", "snap", "render", "measure", "boolean", "symmetry", "extrude", "print", "groom"]) assert.equal(recipes.some((r) => r.id === `3d.${gone}`), false, gone);
});

// ------------------------------------------------------------------ route --

await test("a panel's change runs the modeller's tools on the picked part, and the window takes it quietly", async () => {
  const [first, post] = model.modelParts(await doc());
  const rev = cad.cadState(S).rev;
  const out = await call("POST", `/api/cad/${S}/panel`, { bind: "model.width", value: 60, part: post!.id });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  let d = await doc();
  assert.equal(model.readModel(d, "model.width", post!.id), 60);
  assert.equal(model.readModel(d, "model.width", first!.id), 40, "the other part is untouched");
  const state = cad.cadState(S);
  assert.equal(state.open, true);
  assert.equal(state.by, "agent", "the window reloads on this");
  assert.equal(state.quiet, state.rev, "but without lighting up");
  assert.ok((state.rev ?? 0) > (rev ?? 0));
  for (const [bind, v] of [["model.x", -30], ["model.z", 15], ["model.height", 12], ["model.color", "#ff0000"], ["model.material", "metal"], ["model.visible", false]] as const) {
    const r = await call("POST", `/api/cad/${S}/panel`, { bind, value: v, part: first!.id });
    assert.equal(r.status, 200, `${bind}: ${JSON.stringify(r.body)}`);
  }
  d = await doc();
  assert.equal(model.readModel(d, "model.x", first!.id), -30);
  assert.equal(model.readModel(d, "model.z", first!.id), 15);
  assert.equal(model.readModel(d, "model.height", first!.id), 12);
  assert.equal(model.readModel(d, "model.color", first!.id), "#ff0000");
  assert.equal(model.readModel(d, "model.material", first!.id), "metal");
  assert.equal(model.readModel(d, "model.visible", first!.id), false);
  await call("POST", `/api/cad/${S}/panel`, { bind: "model.visible", value: true, part: first!.id });
});

await test("bevel size and style, and copies with spacing and direction, round trip through the model", async () => {
  const [first] = model.modelParts(await doc());
  assert.equal((await call("POST", `/api/cad/${S}/panel`, { bind: "model.bevelstyle", value: "chamfer", part: first!.id })).status, 400, "a style needs a size first");
  assert.equal((await call("POST", `/api/cad/${S}/panel`, { bind: "model.bevel", value: 2, part: first!.id })).status, 200);
  assert.equal(model.readModel(await doc(), "model.bevel", first!.id), 2);
  assert.equal((await call("POST", `/api/cad/${S}/panel`, { bind: "model.bevelstyle", value: "chamfer", part: first!.id })).status, 200);
  assert.equal(model.readModel(await doc(), "model.bevelstyle", first!.id), "chamfer");
  assert.equal((await call("POST", `/api/cad/${S}/panel`, { bind: "model.gap", value: 80, part: first!.id })).status, 400, "make copies first");
  const made = await call("POST", `/api/cad/${S}/panel`, { bind: "model.count", value: 4, part: first!.id });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  let d = await doc();
  assert.equal(model.readModel(d, "model.count", first!.id), 4);
  assert.equal((await call("POST", `/api/cad/${S}/panel`, { bind: "model.gap", value: 80, part: first!.id })).status, 200);
  assert.equal((await call("POST", `/api/cad/${S}/panel`, { bind: "model.dir", value: 90, part: first!.id })).status, 200);
  d = await doc();
  assert.equal(model.readModel(d, "model.gap", first!.id), 80);
  assert.equal(model.readModel(d, "model.dir", first!.id), 90);
  assert.equal(model.readModel(d, "model.count", first!.id), 4, "the count survived changing the spacing");
  assert.equal(model.modelParts(d).length, 2, "the copies are not parts to pick");
  assert.equal((await call("POST", `/api/cad/${S}/panel`, { bind: "model.count", value: 1, part: first!.id })).status, 400, "letting go of a repeat is asked for, not done by a stepper");
});

await test("the route refuses what the model cannot take, does nothing on GET, and refuses when 3D is off", async () => {
  const bad = await call("POST", `/api/cad/${S}/panel`, { bind: "model.width", value: "wide" });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /number/);
  assert.equal((await call("POST", `/api/cad/${S}/panel`, { bind: "model.part", value: "x" })).status, 400, "the picked part is the canvas's");
  assert.equal((await call("POST", `/api/cad/${S}/panel`, { bind: "bpm", value: 1 })).status, 400);
  const rev = cad.cadState(S).rev;
  assert.notEqual((await call("GET", `/api/cad/${S}/panel`)).status, 200);
  assert.equal(cad.cadState(S).rev, rev);
  off = true;
  assert.equal((await call("POST", `/api/cad/${S}/panel`, { bind: "model.width", value: 50 })).status, 403);
  off = false;
  assert.equal((await call("POST", "/api/cad/nosuchchat/panel", { bind: "model.width", value: 50 })).status, 404);
});

// ------------------------------------------------------------------ agent --

await test("the agent's panacea_set changes the model, and the canvas is described from the model", async () => {
  const hooks = {} as never;
  const placed = await panacea.runPanaceaTool(S, "panacea_place", { recipe: "3d.size", why: "to size the parts" }, hooks);
  assert.ok(placed.ok, placed.summary);
  const [, post] = model.modelParts(await doc());
  const set = await panacea.runPanaceaTool(S, "panacea_set", { values: { "model.part": post!.id, "model.depth": 44 } }, hooks);
  assert.ok(set.ok, set.summary);
  assert.equal(model.readModel(await doc(), "model.depth", post!.id), 44);
  const look = await panacea.runPanaceaTool(S, "panacea_look", {}, hooks);
  assert.match(look.summary, /model\.depth=44/);
  const bad = await panacea.runPanaceaTool(S, "panacea_set", { values: { "model.depth": "deep" } }, hooks);
  assert.equal(bad.ok, false);
  assert.equal(model.readModel(await doc(), "model.depth", post!.id), 44);
});

server.close();
console.log(`\n${passed} panacea-model tests passed`);
process.exit(0);
