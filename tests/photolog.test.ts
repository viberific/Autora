/**
 * The Photo command log (server/photodesk.ts, server/photolog.ts): every change to the picture is a command with who made it
 * and what; the picture from before each is a copy of the working file, so going back to before a command puts it back; the
 * person's saves while they paint are one command; and the look of the picture is the person's, so the agent takes back only its
 * own changes. The editor's side is in photo/overlay/autora.rs; here a stand-in command line, and the window is played by the test.
 *
 *   npx tsx tests/photolog.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autora-photolog-"));
process.env.AUTORA_STATE_DIR = path.join(dir, "state");
// A stand-in build: an editor page, and a command line. doc.save writes a fixed line; doc.inspect reads the layers named in the
// opened file when it begins "layers:" (so a picture the person "painted" has layers), else one Background.
const build = path.join(dir, "photo");
fs.mkdirSync(path.join(build, "web"), { recursive: true });
fs.mkdirSync(path.join(build, "native"), { recursive: true });
fs.writeFileSync(path.join(build, "web", "index.html"), "<!doctype html><title>stand-in</title>");
fs.writeFileSync(
  path.join(build, "native", "photocraft-cli"),
  `#!/usr/bin/env node
const fs = require("node:fs");
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  let opened = "";
  for (const line of input.split("\\n").filter(Boolean)) {
    const r = JSON.parse(line);
    if (r.method === "doc.open") { try { opened = fs.readFileSync(r.params.path, "utf8"); } catch { opened = ""; } }
    if (r.method === "doc.save") fs.writeFileSync(r.params.path, "saved by the command line");
    const names = opened.startsWith("layers:") ? opened.slice(7).split(",") : ["Background"];
    const result = r.method === "doc.inspect" ? { size: { width: 64, height: 48 }, layers: names.map((name) => ({ name })) }
      : r.method === "batch" ? { results: (r.params.steps || []).map(() => ({ ok: true })) } : {};
    process.stdout.write(JSON.stringify({ id: r.id, ok: true, result }) + "\\n");
  }
});
`,
  { mode: 0o755 },
);
process.env.AUTORA_PHOTO_DIR = build;

const express = (await import("express")).default;
const photo = await import("../server/photodesk");
const { describePhotoChange } = await import("../server/photolog");
const { looksOnly } = await import("../server/modes");

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

await test("a picture change is said in a colleague's words: size, layers added and removed, settings", () => {
  const a = { size: { width: 100, height: 80 }, layers: [{ id: "1", name: "Background", visible: true, opacity: 1 }] };
  assert.deepEqual(describePhotoChange(a, structuredClone(a)), ["changed the picture"], "pixels the reading cannot see");
  const b = { size: { width: 200, height: 160 }, layers: [{ id: "1", name: "Background", visible: true, opacity: 1 }, { id: "2", name: "Sky" }] };
  assert.deepEqual(describePhotoChange(a, b), ["resized the picture from 100x80 to 200x160", 'added the layer "Sky"']);
  assert.deepEqual(describePhotoChange(b, a), ["resized the picture from 200x160 to 100x80", 'removed the layer "Sky"']);
  const c = { ...a, layers: [{ id: "1", name: "Background", visible: false, opacity: 0.5 }] };
  assert.deepEqual(describePhotoChange(a, c), ['changed "Background": visible, opacity']);
  assert.deepEqual(describePhotoChange(undefined, a), ["changed the picture"]);
});

const S = "photolog1";
const app = express();
const pushes: Array<Record<string, unknown>> = [];
photo.photoRoutes(app, { exists: (id) => id === S, incognito: () => false, off: () => false, push: (_i, m) => { pushes.push(m); }, visible: () => false });
const server = app.listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/photo/${S}`;
const work = path.join(process.env.AUTORA_STATE_DIR, "photo", S, "work.pcraft");
const events: Array<{ who: string; name: string }> = [];
photo.onPhotoCommand((_s, c) => events.push({ who: c.who, name: c.name }));
const run = (tool: string, args: Record<string, unknown> = {}) => photo.runPhotoTool(S, tool, args, { cwd: dir });
const put = (text: string) => fetch(`${base}/doc`, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: text });
const content = () => fs.readFileSync(work, "utf8");
const log = () => photo.photoLog(S);
await fetch(`${base}/open`, { method: "POST" });

try {
  await test("the agent starting a picture begins the log", async () => {
    const out = await run("photo_open", { new: { width: 64, height: 48 } });
    assert.ok(out.ok, out.summary);
    assert.deepEqual(log().map((c) => [c.name, c.who, c.before]), [["open", "agent", null]]);
    assert.match(log()[0]!.summary, /started a new 64x48 canvas/);
  });

  await test("the person's saves while they paint are one command by them, said from where the run began", async () => {
    assert.equal((await put("layers:Background,Sky")).status, 200);
    assert.equal((await put("layers:Background,Sky,Sun")).status, 200);
    const l = log();
    assert.equal(l.length, 2, "two saves, one command");
    assert.deepEqual([l[1]!.name, l[1]!.who], ["person_edit", "person"]);
    assert.match(l[1]!.summary, /added the layer "Sky"; added the layer "Sun"/);
    assert.ok(l[1]!.before !== null);
  });

  await test("a save that changed nothing is not a command", async () => {
    assert.equal((await put("layers:Background,Sky,Sun")).status, 200);
    assert.equal(log().length, 2);
  });

  await test("the agent's edit is a command by it, said by the commands it applied", async () => {
    const out = await run("photo_edit", { commands: [{ id: "filter.blur.gaussianBlur", params: { radius: 3 } }, { id: "layer.new.layer" }] });
    assert.ok(out.ok, out.summary);
    const last = log().at(-1)!;
    assert.deepEqual([last.name, last.who], ["agent_edit", "agent"]);
    assert.equal(last.summary, "applied filter.blur.gaussianBlur, layer.new.layer");
    assert.equal(content(), "saved by the command line");
    assert.deepEqual(events.map((e) => `${e.who}:${e.name}`), ["agent:open", "person:person_edit", "person:person_edit", "agent:agent_edit"], "the run is told again, not as a new command");
  });

  await test("the agent reads the log, and what the person changed since a revision", async () => {
    const out = await run("photo_history");
    assert.ok(out.ok);
    assert.match(out.summary, /#2 the person \(person_edit.*Sky/);
    assert.match(out.summary, /#3 you \(agent_edit/);
    assert.match(out.summary, /the picture goes back to just before it/);
    const since = await run("photo_history", { since_revision: log()[1]!.rev });
    assert.ok(!since.summary.includes("#2 ") && since.summary.includes("#3 "));
  });

  await test("the look is the person's: the agent cannot take back a command with theirs at or after it, and nothing changes", async () => {
    for (const n of [1, 2]) {
      const out = await run("photo_history", { action: "revert", n });
      assert.equal(out.ok, false);
      assert.match(out.summary, /the person's own work/);
    }
    assert.equal(content(), "saved by the command line");
  });

  await test("the agent takes back its own latest edit: the picture before it comes back, and the window is told to load it", async () => {
    const out = await run("photo_history", { action: "revert", n: 3 });
    assert.ok(out.ok, out.summary);
    assert.equal(content(), "layers:Background,Sky,Sun", "the person's painting, as it was before the agent's edit");
    const last = log().at(-1)!;
    assert.deepEqual([last.name, last.who], ["revert", "agent"]);
    assert.match(last.summary, /before command 3/);
    const state = photo.photoState(S);
    assert.equal(state.by, "agent", "so the window loads it");
    assert.equal(state.hand, undefined);
  });

  await test("the person goes back to before any command through the route, and it is a command of theirs", async () => {
    const post = (body: unknown) => fetch(`${base}/commands/revert`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await post({ n: 2 })).status, 200);
    assert.equal(content(), "saved by the command line", "before their painting began");
    const last = log().at(-1)!;
    assert.deepEqual([last.name, last.who], ["revert", "person"]);
    assert.equal((await post({ n: 999 })).status, 404);
    assert.equal((await post({ n: "x" })).status, 400);
    const listed = (await (await fetch(`${base}/commands`)).json()) as { commands: unknown[] };
    assert.equal(listed.commands.length, log().length);
  });

  await test("only the newest ten pictures are kept; an older one says it is gone", async () => {
    for (let i = 0; i < 12; i++) assert.ok((await run("photo_edit", { commands: [{ id: `layer.new.layer${i}` }] })).ok);
    const kept = fs.readdirSync(path.join(process.env.AUTORA_STATE_DIR!, "photo", S, "versions")).filter((f) => /^v\d+\.pcraft$/.test(f));
    assert.ok(kept.length <= 10, `${kept.length} kept`);
    const mine = log().filter((c) => c.name === "agent_edit").slice(-12);
    const gone = await run("photo_history", { action: "revert", n: mine[0]!.n });
    assert.equal(gone.ok, false);
    assert.match(gone.summary, /no longer kept/);
    assert.ok((await run("photo_history", { action: "revert", n: mine[11]!.n })).ok, "the newest is still there");
  });

  await test("the log is kept on disk with the picture's state", () => {
    const saved = JSON.parse(fs.readFileSync(path.join(process.env.AUTORA_STATE_DIR!, "photo", S, "state.json"), "utf8"));
    assert.equal(saved.log.length, log().length);
    assert.ok(saved.lseq >= log().length);
  });

  await test("photo_history is looking when it reads and a change when it reverts", () => {
    assert.equal(looksOnly("photo_history", {}), true);
    assert.equal(looksOnly("photo_history", { action: "revert", n: 1 }), false);
  });
} finally {
  server.close();
  photo.dropPhoto(S);
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(`photolog: ${passed} passed`);
setTimeout(() => process.exit(0), 50);
