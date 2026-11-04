/**
 * Autora 3D through a real turn: the model asks for a cad_ tool, the tool runs on the chat's model, the window is
 * told, and what the person then does in the window is what the agent sees next.
 *
 *   npx tsx tests/e2e-cad.test.ts
 */
import assert from "node:assert/strict";
import WebSocket from "ws";
import { startApp, sleep, type App } from "./e2e-harness";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

async function main() {
  const app: App = await startApp();
  try {
    console.log("Autora 3D");
    const s = await app.newSession("modelling", "build");
    const told: any[] = [];
    const ws = new WebSocket(`${app.base.replace(/^http/, "ws")}/ws/${s}`);
    ws.on("message", (raw) => { const m = JSON.parse(String(raw)); if (m.type === "caddesk") told.push(m.state); });
    await new Promise((r) => ws.once("open", r));
    await sleep(200);

    await test("a chat starts with the window shut, and the page is told so", async () => {
      assert.equal((await app.api("GET", `/api/cad/${s}`)).body.open, false);
      assert.equal(told[0]?.open, false);
    });

    await test("the tools are in the list when the person talks about 3D printing, and the agent uses them", async () => {
      app.seen.length = 0;
      app.script.push({ tools: [{ name: "cad_shape_add", args: { kind: "box", width: 60, depth: 30, height: 20, name: "Stand" } }] });
      app.script.push({ text: "Made a stand." });
      await app.turn(s, "model a phone stand I can 3D print");
      assert.ok(app.seen[0].tools.includes("cad_shape_add"), "offered from the first step");
      assert.match(app.seen[0].system, /Autora 3D/);
      const state = (await app.api("GET", `/api/cad/${s}`)).body;
      assert.equal(state.open, true);
      assert.equal(state.shapes, 1);
      assert.equal(state.by, "agent");
      assert.ok(told.some((t) => t.open && t.by === "agent" && t.shapes === 1), "the page was told the agent changed the model");
      const result = JSON.stringify(app.seen[app.seen.length - 1].messages);
      assert.match(result, /Stand/);
    });

    await test("what the person changes in the window is what the agent sees next", async () => {
      const { body } = await app.api("GET", `/api/cad/${s}/doc`);
      body.doc.bodies[0].name = "Renamed by hand";
      assert.equal((await app.api("PUT", `/api/cad/${s}/doc`, { doc: body.doc })).status, 200);
      assert.ok(told.some((t) => t.by === "person"), "and the page knows whose change it was");
      app.script.push({ tools: [{ name: "cad_scene_get" }] });
      app.script.push({ text: "Seen." });
      await app.turn(s, "what does the model look like now?");
      assert.match(JSON.stringify(app.seen[app.seen.length - 1].messages), /Renamed by hand/);
    });

    await test("every change is a command in the log and an event, with who made it; the person can go back to before one", async () => {
      const log = (await app.api("GET", `/api/cad/${s}/commands`)).body.commands as { n: number; name: string; who: string; summary: string }[];
      const add = log.find((c) => c.name === "shape_add");
      assert.ok(add && add.who === "agent", JSON.stringify(log));
      const edit = log.find((c) => c.name === "person_edit");
      assert.ok(edit && edit.who === "person" && /Renamed by hand/.test(edit.summary), JSON.stringify(log));
      assert.ok(!log.some((c) => c.name === "scene_get"), "reading is not a command");
      const events = await app.events(s);
      const evs = events.filter((e) => e.kind === "cad.command");
      assert.ok(evs.some((e) => e.actor === "agent") && evs.some((e) => e.actor === "person"), "both reached the event log");
      assert.equal((await app.api("POST", `/api/cad/${s}/revert`, { n: edit!.n })).status, 200);
      const { body } = await app.api("GET", `/api/cad/${s}/doc`);
      assert.equal(body.doc.bodies[0].name, "Stand", "back to before the rename");
      assert.equal((await app.api("POST", `/api/cad/${s}/revert`, { n: 99999 })).status, 404);
      assert.equal((await app.api("POST", `/api/cad/${s}/revert`, { n: "x" })).status, 400);
      const after = (await app.api("GET", `/api/cad/${s}/commands`)).body.commands as { name: string; who: string }[];
      assert.equal(after.at(-1)!.name, "history_revert");
      // The person puts their rename back, so what follows sees the model it expects.
      body.doc.bodies[0].name = "Renamed by hand";
      assert.equal((await app.api("PUT", `/api/cad/${s}/doc`, { doc: body.doc })).status, 200);
    });

    await test("an STL export lands in the thread as a file, not as base64 in the conversation", async () => {
      app.script.push({ tools: [{ name: "cad_export", args: { format: "stl", name: "stand" } }] });
      app.script.push({ text: "Exported." });
      const events = await app.turn(s, "export it as STL");
      const said = JSON.stringify(app.seen[app.seen.length - 1].messages);
      assert.match(said, /stand\.stl/);
      assert.ok(said.length < 200_000, "no file contents in the prompt");
      const arts = (await app.api("GET", "/api/artifacts")).body;
      assert.ok(JSON.stringify(arts).includes("stand.stl"));
      assert.ok(events.length > 0);
    });

    await test("a restart keeps the model and the window", async () => {
      await sleep(700);
      ws.close();
      await app.restart();
      const state = (await app.api("GET", `/api/cad/${s}`)).body;
      assert.equal(state.open, true);
      assert.equal(state.shapes, 1);
      const { body } = await app.api("GET", `/api/cad/${s}/doc`);
      assert.equal(body.doc.bodies[0].name, "Renamed by hand");
    });

    await test("switched off on the Tools page, the tools go and the window cannot be opened", async () => {
      assert.equal((await app.api("PATCH", "/api/settings", { tools: { cad: { enabled: false } } })).status, 200);
      app.seen.length = 0;
      app.script.push({ text: "No." });
      await app.turn(s, "model a 3D printed bracket");
      assert.ok(!app.seen[0].tools.some((n) => n.startsWith("cad_")));
      assert.equal((await app.api("POST", `/api/cad/${s}/open`)).status, 403);
      assert.equal((await app.api("PATCH", "/api/settings", { tools: { cad: { enabled: true } } })).status, 200);
    });
  } finally {
    await app.stop();
  }
  console.log(`\n${passed} passed`);
}

main().then(() => process.exit(0), (err) => { console.error(err); process.exit(1); });
