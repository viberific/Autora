/**
 * Autora Photo's agent path: photo_edit runs on the server at speed, whatever is open, and is kept as the agent's change;
 * and the layer the person is on is told to the agent. Here a stand-in command line.
 *
 *   npx tsx tests/photo-hand.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autora-photo-hand-"));
process.env.AUTORA_STATE_DIR = path.join(dir, "state");
// A stand-in build: an editor page, and a command line that answers every request and writes what doc.save names.
const build = path.join(dir, "photo");
fs.mkdirSync(path.join(build, "web"), { recursive: true });
fs.mkdirSync(path.join(build, "native"), { recursive: true });
fs.writeFileSync(path.join(build, "web", "index.html"), "<!doctype html><title>stand-in</title>");
const cli = path.join(build, "native", "photocraft-cli");
fs.writeFileSync(
  cli,
  `#!/usr/bin/env node
const fs = require("node:fs");
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  for (const line of input.split("\\n").filter(Boolean)) {
    const r = JSON.parse(line);
    if (r.method === "doc.save") fs.writeFileSync(r.params.path, "saved by the command line");
    const result = r.method === "doc.inspect" ? { size: { width: 64, height: 48 }, layers: [{ name: "Background" }] }
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

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

const session = "hand-chat";
const app = express();
photo.photoRoutes(app, { exists: (id) => id === session, incognito: () => false, off: () => false });
const server = app.listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/photo/${session}`;

// A picture, and the window open on it.
fs.mkdirSync(path.join(process.env.AUTORA_STATE_DIR, "photo", session), { recursive: true });
fs.writeFileSync(path.join(process.env.AUTORA_STATE_DIR, "photo", session, "work.pcraft"), "the picture");
await fetch(`${base}/open`, { method: "POST" });

const commands = [{ id: "filter.blur.gaussianBlur", params: { radius: 3 } }, { id: "layer.new.layer", params: {} }];
const edit = () => photo.runPhotoTool(session, "photo_edit", { commands }, { cwd: dir });

await test("photo_edit runs on the server at speed and is kept as the agent's change", async () => {
  const started = Date.now();
  const out = await edit();
  assert.equal(out.ok, true, out.summary);
  assert.doesNotMatch(out.summary, /by hand/);
  assert.ok(Date.now() - started < 9000);
  assert.equal(fs.readFileSync(path.join(process.env.AUTORA_STATE_DIR!, "photo", session, "work.pcraft"), "utf8"), "saved by the command line");
  assert.equal(photo.photoState(session).by, "agent");
});

await test("the layer the person is on is told to the agent, and cleared", async () => {
  assert.equal(photo.photoPickNote(session), null);
  await fetch(`${base}/pick`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: '"Sky" (of 3 layers)' }) });
  assert.match(photo.photoPickNote(session) ?? "", /working on this layer.*"Sky" \(of 3 layers\)/);
  await fetch(`${base}/pick`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "" }) });
  assert.equal(photo.photoPickNote(session), null);
});

server.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log(`photo-hand: ${passed} passed`);
