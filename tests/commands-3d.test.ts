/**
 * Autora 3D's command layer: who may make a command, the log of what was made, and reverting to before one.
 * Needs the modeller's engine built (`npm --prefix autora-3d run build:engine`).
 *
 *   npx tsx tests/commands-3d.test.ts
 */
import assert from "node:assert/strict";

async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

const core = await import(new URL("../dist/autora-3d-engine/engine.mjs", import.meta.url).href);
await core.initManifold();

const ball = async (e: any) => ((await e.execute("sculpt_blend", { parts: [{ kind: "sphere", at: { x: 0, y: 0, z: 30 }, radius: 25 }], detail: 20 })).result as { id: string }).id;

await test("the person's own commands are not in the agent's tool list, and the agent is refused them", async () => {
  assert.ok(!core.Engine.tools.some((t: { name: string }) => t.name === "sculpt_apply"), "not offered to the agent");
  assert.ok(core.TOOL_SPECS.some((t: { name: string; authority?: string }) => t.name === "sculpt_apply" && t.authority === "person"), "but it is a command");
  const e = new core.Engine(core.emptyDoc());
  const id = await ball(e);
  const mesh = e.getDoc().bodies[0].mesh;
  const refused = await e.execute("sculpt_apply", { id, positions: mesh.positions });
  assert.ok(!refused.ok && /own hand/.test(refused.error), JSON.stringify(refused));
  const batched = await e.execute("batch", { commands: [{ tool: "sculpt_apply", args: { id, positions: mesh.positions } }] });
  assert.ok(!batched.ok && /Nothing was changed/.test(batched.error ?? ""), JSON.stringify(batched));
});

await test("the person's stroke goes in, keeps the footprint true, and rejects a wrong surface", async () => {
  const e = new core.Engine(core.emptyDoc());
  const id = await ball(e);
  const before = e.getDoc().bodies[0];
  const moved = before.mesh.positions.map((n: number, i: number) => (i % 3 === 2 ? n + 5 : n));
  const ok = await e.execute("sculpt_apply", { id, positions: moved }, { who: "person" });
  assert.ok(ok.ok && ok.changed, JSON.stringify(ok));
  const after = e.getDoc().bodies[0];
  assert.ok(after.extrusionHeight > before.extrusionHeight + 4, "height follows the surface");
  assert.ok(!(await e.execute("sculpt_apply", { id, positions: [1, 2, 3] }, { who: "person" })).ok);
  assert.ok(!(await e.execute("sculpt_apply", { id, positions: moved.map(() => NaN) }, { who: "person" })).ok);
});

await test("every change is logged with who made it and a short summary; reads are not", async () => {
  const e = new core.Engine(core.emptyDoc());
  await e.execute("shape_add", { kind: "box", width: 40, depth: 20, height: 10 });
  await e.execute("scene_get", {});
  const bad = await e.execute("shape_move", { ids: ["nope"], by: { x: 1 } });
  assert.ok(!bad.ok);
  const log = e.commandLog();
  assert.deepEqual(log.map((r: { name: string }) => r.name), ["shape_add", "shape_move"]);
  assert.equal(log[0].who, "agent");
  assert.ok(log[0].changed && log[0].ok);
  assert.ok(!log[1].ok && /nope|shape/i.test(log[1].summary), log[1].summary);
  assert.ok(log.every((r: { summary: string }) => r.summary.length <= 160));
  assert.ok(!("before" in log[0]), "the models are not in the entries");
  const big = await e.execute("mesh_import", { data: "A".repeat(5000), name: "x.stl" });
  assert.ok(!big.ok);
  assert.ok(e.commandLog().at(-1).summary.length <= 160 && !/AAAA/.test(e.commandLog().at(-1).summary), "a file is never in a summary");
});

await test("a change the window sends is logged as the person's, described from the difference", async () => {
  const e = new core.Engine(core.emptyDoc());
  await ball(e);
  const doc = e.getDoc();
  const body = doc.bodies[0];
  e.setDoc({ ...doc, bodies: [{ ...body, mesh: { positions: body.mesh.positions.map((n: number) => n + 0.1), indices: body.mesh.indices } }] }, "person");
  const last = e.commandLog().at(-1);
  assert.equal(last.name, "person_edit");
  assert.equal(last.who, "person");
  assert.match(last.summary, /sculpted/);
  e.setDoc({ ...e.getDoc(), bodies: [] }, "person");
  assert.match(e.commandLog().at(-1).summary, /removed/);
});

await test("reverting to before a command puts the model back as a new change that can be undone, and is itself logged", async () => {
  const e = new core.Engine(core.emptyDoc());
  await e.execute("shape_add", { kind: "box", width: 40, depth: 20, height: 10, name: "A" });
  await e.execute("shape_add", { kind: "box", width: 40, depth: 20, height: 10, name: "B" });
  await e.execute("shape_delete", { ids: [e.getDoc().bodies[0].id] });
  const log = e.commandLog();
  const second = log.find((r: { name: string; n: number }) => r.name === "shape_add" && r.n === 2);
  assert.equal(e.getDoc().bodies.length, 1);
  assert.ok(e.revertTo(second.n));
  assert.equal(e.getDoc().bodies.length, 1, "before the second add there was one shape (A), the delete had removed it, now A is back");
  assert.equal(e.getDoc().bodies[0].name, "A");
  assert.equal(e.commandLog().at(-1).name, "history_revert");
  assert.ok(e.undo(), "the revert can be undone");
  assert.equal(e.getDoc().bodies[0].name, "B");
  assert.equal(e.revertTo(9999), false);
  const reads = await e.execute("scene_get", {});
  assert.ok(reads.ok);
});

await test("watchers hear each command as it is logged, and can stop", async () => {
  const e = new core.Engine(core.emptyDoc());
  const heard: string[] = [];
  const stop = e.onCommand((r: { name: string }) => heard.push(r.name));
  await e.execute("shape_add", { kind: "box", width: 10, depth: 10, height: 10 });
  stop();
  await e.execute("shape_add", { kind: "box", width: 10, depth: 10, height: 10 });
  assert.deepEqual(heard, ["shape_add"]);
});

await test("history_log tells the agent what was done and by whom, and what the person changed since it looked", async () => {
  const e = new core.Engine(core.emptyDoc());
  await e.execute("shape_add", { kind: "box", width: 10, depth: 10, height: 10, name: "A" });
  const seen = e.revision();
  e.setDoc({ ...e.getDoc(), bodies: e.getDoc().bodies.map((b: any) => ({ ...b, name: "Moved by hand" })) }, "person");
  const all = (await e.execute("history_log", {})).result as { commands: { name: string; who: string }[]; total: number };
  assert.deepEqual(all.commands.map((c) => `${c.who}:${c.name}`), ["agent:shape_add", "person:person_edit"]);
  const since = (await e.execute("history_log", { since_revision: seen })).result as { commands: { name: string; summary: string }[] };
  assert.equal(since.commands.length, 1);
  assert.match(since.commands[0].summary, /changed Moved by hand|changed/);
  assert.equal(e.commandLog().length, 2, "asking is not a command");
});

console.log("command layer tests passed");
