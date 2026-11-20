/**
 * Autora 3D's generation mode: sight for a model that reads only text (cad_scene_view draws the model as text and says
 * what floats or came apart), body plans that block a figure out with real proportions (cad_sculpt_figure), a form made
 * again in place (sculpt_blend replace), and the gate that keeps generation to when the person asks for it.
 *
 * The engine parts run from the source; the server's gate needs the modeller built (`npm --prefix autora-3d run build`)
 * and is skipped without it, as tests/cad.test.ts is.
 *
 *   npx tsx tests/sight-3d.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AUTORA_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "autora-sight-"));

const { Engine } = await import("../autora-3d/src/core/engine");
const { figure, PLANS } = await import("../autora-3d/src/utils/figures");
const { FAMILIES, loadedFamilies, loadedFromLog, openFamilyIds, unloadedIndex, withoutUnloaded } = await import("../server/toolload");
const cad = await import("../server/caddesk");
const { cadSPECS } = await import("../server/specs/cad");

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}
const run = async (e: InstanceType<typeof Engine>, name: string, args: Record<string, unknown>) => {
  const r = (await e.execute(name, args)) as { ok: boolean; result?: any; error?: string };
  assert.ok(r.ok, `${name}: ${r.error}`);
  return r.result;
};

console.log("3D sight and generation");

await test("scene_view draws the views as text, at one scale, with heights to read off", async () => {
  const e = new Engine();
  await run(e, "shape_add", { kind: "box", width: 40, depth: 20, height: 80 });
  const look = await run(e, "scene_view", { views: ["front", "right", "top"], width: 40 });
  assert.match(look.text, /FRONT, seen from the front/);
  assert.match(look.text, /RIGHT, seen from the \+x side/);
  assert.match(look.text, /TOP, seen from above/);
  assert.match(look.text, /One column 2 mm, one row 4 mm/, "the longest side (80 mm) fills 40 columns, and a row is two columns tall");
  const front = look.text.split("FRONT")[1].split("RIGHT")[0];
  const rows = front.split("\n").filter((l: string) => /\|[@#+-]/.test(l));
  assert.equal(rows.length, 20, "80 mm tall at 4 mm a row");
  assert.ok(rows.every((l: string) => l.split("|")[1].trim().length === 20), "40 mm wide at 2 mm a column");
  assert.deepEqual(look.findings, []);
  assert.match(look.text, /100% mirror images/);
});

await test("scene_view says what a glance would catch: a form in pieces, a shape that floats, nothing on the ground", async () => {
  const e = new Engine();
  await run(e, "sculpt_blend", { parts: [{ kind: "sphere", at: { x: 0, y: 0, z: 30 }, radius: 30 }, { kind: "sphere", at: { x: 100, y: 0, z: 30 }, radius: 10 }] });
  await run(e, "shape_add", { kind: "box", width: 20, depth: 20, height: 20, x: 0, y: 150, elevation: 80 });
  const look = await run(e, "scene_view", {});
  assert.equal(look.findings.length, 2, look.findings.join("\n"));
  assert.match(look.findings[0], /came out as 2 separate pieces.*x 100/);
  assert.match(look.findings[1], /Box 2 .* floats: nothing under or beside it touches it/);
  const high = new Engine();
  await run(high, "shape_add", { kind: "box", width: 20, depth: 20, height: 20, elevation: 30 });
  assert.ok((await run(high, "scene_view", {})).findings.some((f: string) => /does not reach the ground: its lowest point is 30 mm up/.test(f)));
});

await test("scene_view can letter shapes and show only a slice of heights", async () => {
  const e = new Engine();
  await run(e, "shape_add", { kind: "box", width: 20, depth: 20, height: 20, x: -30 });
  await run(e, "shape_add", { kind: "box", width: 20, depth: 20, height: 60, x: 30 });
  const lettered = await run(e, "scene_view", { views: ["front"], byShape: true });
  assert.match(lettered.text, /Letters: A Box 1 \(body_1\), B Box 2 \(body_2\)/);
  assert.match(lettered.text, /\|A+ +B+/);
  const slice = await run(e, "scene_view", { views: ["top"], from: 30 });
  assert.match(slice.text, /Only what lies between z 30/);
  assert.ok(!/A/.test(slice.text.split("TOP")[1]) && /[@#+-]/.test(slice.text.split("TOP")[1]), "above 30 mm only the tall box is drawn");
});

await test("every body plan makes one grounded, symmetric form with nothing floating", async () => {
  for (const plan of PLANS) {
    const e = new Engine();
    const made = await run(e, "sculpt_figure", { plan, detail: 72 });
    assert.ok(made.parts.length >= 10 && made.parts.every((p: { label: string }) => p.label), `${plan}: named parts`);
    assert.ok(made.landmarks.length > 20, `${plan}: landmarks`);
    const look = await run(e, "scene_view", { views: ["front"] });
    assert.deepEqual(look.findings, [], `${plan}: ${look.findings.join("; ")}`);
    // The blend's own grid is not centred on the mirror plane, so the surface itself is a cell or so off true.
    const match = Number(/(\d+)% mirror images/.exec(look.text)?.[1]);
    assert.ok(match >= 95, `${plan} is symmetric (${match}%)`);
  }
});

await test("a biped is measured in heads: realistic 7.5, chibi 3, and the size is its height", () => {
  const head = (f: ReturnType<typeof figure>) => f.parts.find((p) => p.label === "head")!;
  const real = figure({ plan: "biped", size: 180 });
  const chibi = figure({ plan: "biped", size: 180, style: "chibi" });
  assert.ok(Math.abs(head(real).radii!.z * 2 - 24) < 0.5, `a realistic head is 180 / 7.5 = 24 mm tall, got ${head(real).radii!.z * 2}`);
  assert.ok(Math.abs(head(chibi).radii!.z * 2 - 60) < 0.5, `a chibi head is 180 / 3 = 60 mm tall, got ${head(chibi).radii!.z * 2}`);
  assert.ok(head(real).at.z + head(real).radii!.z <= 180.01, "the head's top is the height");
  assert.match(real.landmarks, /^7\.5 heads tall/);
  const longer = figure({ plan: "biped", legs: 1.3 });
  const knee = (f: ReturnType<typeof figure>) => f.parts.find((p) => p.label === "left shin")!.at.z;
  assert.ok(knee(longer) > knee(real), "legs 1.3 raises the knee");
  assert.throws(() => figure({ plan: "biped", head: 9 }), /0\.4 to 2\.5/);
  assert.throws(() => figure({ plan: "dragon" as "biped" }), /plan must be one of/);
});

await test("left and right parts mirror each other exactly, turns included", () => {
  for (const plan of PLANS) {
    const f = figure({ plan });
    for (const left of f.parts.filter((p) => p.label.startsWith("left "))) {
      const right = f.parts.find((p) => p.label === left.label.replace(/^left /, "right "));
      assert.ok(right, `${plan}: ${left.label} has a right`);
      assert.equal(right!.at.x, -left.at.x);
      assert.equal(right!.at.z, left.at.z);
      if (left.turn) assert.deepEqual(right!.turn, { x: left.turn.x, y: -left.turn.y, z: -left.turn.z });
    }
  }
});

await test("sculpt_blend replace makes the form again in place, keeping the shape", async () => {
  const e = new Engine();
  const made = await run(e, "sculpt_figure", { plan: "fish", detail: 48, name: "Carp", color: "#d08030" });
  const parts = made.parts.map((p: Record<string, unknown>) => p.label === "body" ? { ...p, radii: { x: 30, y: 100, z: 60 } } : p);
  const again = await run(e, "sculpt_blend", { parts, smooth: made.smooth, detail: 48, replace: made.id });
  assert.equal(again.id, made.id);
  const doc = e.getDoc();
  assert.equal(doc.bodies.length, 1, "no second shape");
  assert.equal(doc.bodies[0].name, "Carp");
  assert.equal(doc.bodies[0].color, "#d08030");
  assert.match(again.note, /Made again in place/);
  await run(e, "shape_add", { kind: "box", width: 10, depth: 10, height: 10, x: 200 });
  const r = (await e.execute("sculpt_blend", { parts, replace: doc.bodies.length ? e.getDoc().bodies[1].id : "" })) as { ok: boolean; error?: string };
  assert.ok(!r.ok && /is not a mesh shape/.test(r.error ?? ""), "an outline shape is not made again from parts");
});

await test("generation comes in only on the person's own ask, and the agent cannot bring it in", () => {
  const lazy = (said: string, events: { kind: string; payload: Record<string, any> }[] = []) => loadedFamilies({ events, said, lazy: true });
  for (const asks of ["generate a 3D dragon", "Make me a horse in 3D", "create a 3D model of a fox", "can you model me a cat?", "build a 3d knight for my game", "generate me a low-poly creature"]) {
    assert.ok(lazy(asks).has("generate3d"), `"${asks}" asks for a model`);
  }
  for (const guided of ["help me make a 3D horse", "I want to model a dragon in 3D", "show me how to sculpt a cat in 3d", "open the 3D window", "export the model as STL", "what is a 3d printer"]) {
    assert.ok(!lazy(guided).has("generate3d"), `"${guided}" does not ask for a model to be made`);
  }
  assert.ok(lazy("help me make a 3D horse").has("cad"), "the 3D tools themselves still come in");
  // The agent's own ways in: asking for the set, or calling one of its tools.
  assert.ok(!loadedFromLog([{ kind: "tools.enable", payload: { family: "generate3d", why: "asked" } }]).has("generate3d"));
  assert.ok(!loadedFromLog([{ kind: "tool.call", payload: { name: "cad_sculpt_figure" } }]).has("generate3d"));
  assert.ok(loadedFromLog([{ kind: "tools.enable", payload: { family: "generate3d", why: "wanted" } }]).has("generate3d"), "the person's words hold for the rest of the chat");
  // Every tool on still leaves it out, and the index never names it.
  assert.ok(!loadedFamilies({ events: [], all: true }).has("generate3d"));
  assert.ok(loadedFamilies({ events: [], all: true, said: "generate a 3D wolf" }).has("generate3d"));
  assert.ok(!openFamilyIds().includes("generate3d"));
  assert.ok(!(unloadedIndex(new Set()) ?? "").includes("generate3d"));
  // The figure tool is in that set alone; seeing is in the cad set.
  const tools = cadSPECS.filter((t) => t.name === "cad_sculpt_figure" || t.name === "cad_scene_view");
  assert.equal(tools.length, 2);
  assert.deepEqual(withoutUnloaded(tools, new Set(["cad"])).map((t) => t.name), ["cad_scene_view"]);
  assert.equal(FAMILIES.find((f) => f.match("cad_sculpt_figure"))?.id, "generate3d");
});

if (cad.cadAvailable()) {
  await test("the server refuses the figure tool unless the person asked, in a batch too, and the view arrives as text", async () => {
    const s = "sight-test";
    const refused = await cad.runCadTool(s, "cad_sculpt_figure", { plan: "biped" }, { mayGenerate: () => false });
    assert.ok(!refused.ok && /only when the person asks you to generate one/.test(refused.summary));
    const batched = await cad.runCadTool(s, "cad_batch", { commands: [{ tool: "cad_sculpt_figure", args: { plan: "bird" } }] }, {});
    assert.ok(!batched.ok && /only when the person asks/.test(batched.summary));
    const made = await cad.runCadTool(s, "cad_sculpt_figure", { plan: "bird", detail: 48 }, { mayGenerate: () => true });
    assert.ok(made.ok, made.summary);
    const look = await cad.runCadTool(s, "cad_scene_view", { views: ["front"] }, {});
    assert.ok(look.ok);
    assert.ok(look.summary.includes("\nFRONT, seen from the front") && !look.summary.includes("\\n"), "real line breaks, not escaped ones");
    assert.match(look.summary, /Nothing floats or came apart/);
    cad.dropCad(s);
  });
} else {
  console.log("  skip  the server's gate: the modeller is not built (npm --prefix autora-3d run build)");
}

console.log(`\n${passed} passed`);
