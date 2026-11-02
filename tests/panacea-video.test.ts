/**
 * Panacea's Video panels (docs/PANACEA-GAPS.md, G1): a `video.*` control reads the project open in Autora Video and
 * runs the editor's own commands to change it. The pure adapter (reads, the commands a value makes, refusals), the
 * routes (a read never opens the window; a write refuses when Video is off), and the recipes (each wired, none a
 * placebo). The editor itself runs in tests/ui-panacea-video.test.ts.
 *
 *   npx tsx tests/panacea-video.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AUTORA_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "autora-panacea-video-"));

const express = (await import("express")).default;
const video = await import("../src/lib/panacea/apps/video");
const { BUILTINS } = await import("../src/lib/panacea/library");
const { treeLive, unwiredBinds } = await import("../src/lib/panacea/wiring");
const opencut = await import("../server/opencut");

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

const state = (): import("../src/lib/panacea/apps/video").VideoState => ({
  canvas: { width: 1920, height: 1080 },
  fps: { numerator: 30, denominator: 1 },
  tracks: [
    { clips: [{ id: "t1", type: "text", name: "Text", text: "Hello", params: { color: "#ff0000" } }] },
    { clips: [
      { id: "v1", type: "video", name: "Beach", speed: 2, params: { volume: -6, opacity: 0.5, "transform.scaleX": 1.5 } },
      { id: "i1", type: "image", name: "Photo" },
    ] },
    { clips: [{ id: "a1", type: "audio", name: "Song", muted: true }] },
  ],
});

await test("what a control shows is read off the clip it acts on: the picked one if it fits, else the first that does", () => {
  const s = state();
  assert.equal(video.readVideo(s, "video.clip"), "t1");
  assert.equal(video.readVideo(s, "video.clip", "a1"), "a1");
  assert.equal(video.readVideo(s, "video.speed"), 2, "the first clip with speed is the video");
  assert.equal(video.readVideo(s, "video.vol"), -6);
  assert.equal(video.readVideo(s, "video.mute", "a1"), true);
  assert.equal(video.readVideo(s, "video.zoom", "v1"), 1.5);
  assert.equal(video.readVideo(s, "video.opacity", "v1"), 50);
  assert.equal(video.readVideo(s, "video.opacity", "i1"), 100, "a clip that never set it shows the default");
  assert.equal(video.readVideo(s, "video.title"), "Hello");
  assert.equal(video.readVideo(s, "video.titlecolor"), "#ff0000");
  assert.equal(video.readVideo(s, "video.aspect"), "16:9");
  assert.equal(video.readVideo(s, "video.fps"), 30);
  assert.equal(video.readVideo({ ...s, canvas: { width: 1080, height: 1920 } }, "video.aspect"), "9:16");
  assert.equal(video.readVideo({ ...s, canvas: { width: 1000, height: 700 } }, "video.aspect"), "custom");
  assert.equal(video.readVideo({ ...s, tracks: [] }, "video.speed"), undefined, "no clip, nothing to show");
  assert.deepEqual(video.videoOptions(s).map((o) => o.label), ["Hello (text)", "Beach (video)", "Photo (image)", "Song (audio)"]);
});

await test("a value becomes the editor's own command on the clip it acts on", () => {
  const s = state();
  const run = (bind: string, v: unknown, picked?: unknown) => video.videoCommands(s, bind, v as never, picked);
  assert.deepEqual(run("video.speed", 3), { did: "Beach: speed 3×", commands: [{ name: "retime", args: { elementId: "v1", rate: 3, maintainPitch: true } }] });
  assert.equal(((run("video.speed", 100) as unknown) as { commands: Array<{ args: { rate: number } }> }).commands[0]!.args.rate, 4, "held to the range");
  assert.deepEqual((run("video.vol", -12) as { commands: unknown[] }).commands, [{ name: "set_params", args: { elementId: "v1", params: { volume: -12 } } }]);
  assert.deepEqual((run("video.mute", false, "a1") as { commands: unknown[] }).commands, [{ name: "set_params", args: { elementId: "a1", params: { muted: false } } }]);
  assert.deepEqual((run("video.zoom", 2) as { commands: unknown[] }).commands, [{ name: "set_params", args: { elementId: "v1", params: { "transform.scaleX": 2, "transform.scaleY": 2 } } }]);
  assert.deepEqual((run("video.opacity", 40, "i1") as { commands: unknown[] }).commands, [{ name: "set_params", args: { elementId: "i1", params: { opacity: 0.4 } } }]);
  assert.deepEqual((run("video.title", "New words") as { commands: unknown[] }).commands, [{ name: "set_params", args: { elementId: "t1", params: { content: "New words" } } }]);
  assert.deepEqual((run("video.aspect", "9:16") as { commands: unknown[] }).commands, [{ name: "settings", args: { width: 1080, height: 1920 } }]);
  assert.deepEqual((run("video.fps", 24.4) as { commands: unknown[] }).commands, [{ name: "settings", args: { fps: 24 } }]);
});

await test("a value that does not fit, or a clip it does not suit, is refused with a reason", () => {
  const s = state();
  const err = (bind: string, v: unknown, picked?: unknown) => { const r = video.videoCommands(s, bind, v as never, picked); assert.ok("error" in r, bind); return (r as { error: string }).error; };
  assert.match(err("video.vol", 5, "t1"), /title and has no volume.*Clip list/);
  assert.match(err("video.title", "x", "v1"), /has no words/);
  assert.match(err("video.zoom", 2, "a1"), /audio and has no picture/);
  err("video.speed", "fast"); err("video.speed", 0); err("video.aspect", "2:1"); err("video.fps", "x"); err("video.titlecolor", "red"); err("video.title", "  "); err("video.nope", 1);
  assert.ok("error" in video.videoCommands({ ...s, tracks: [] }, "video.vol", 1), "no clip to act on");
});

await test("every Video recipe is wired, and nothing the editor cannot do is offered", () => {
  const recipes = BUILTINS.filter((r) => r.domain === "video");
  assert.equal(recipes.length, 9);
  for (const r of recipes) {
    assert.equal(treeLive(r.tree), true, `${r.id}: ${unwiredBinds(r.tree).join(", ")}`);
    const walk = (n: { bind?: string; children?: unknown[] }) => { if (n.bind?.startsWith("video.")) assert.ok(video.VIDEO_WIRED.includes(n.bind), `${r.id}: ${n.bind}`); (n.children as typeof n[] | undefined)?.forEach(walk); };
    walk(r.tree);
  }
  for (const gone of ["timeline", "trim", "transition", "grade", "stabilise", "captions", "keyframes", "lut", "mix", "playback", "pip", "thumbnail"]) assert.equal(recipes.some((r) => r.id === `video.${gone}`), false, gone);
});

const S = "panelvideo1";
let off = false;
const app = express();
opencut.opencutRoutes(app, { exists: (id) => id === S, off: () => off, push: () => undefined });
const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const call = async (method: string, url: string, body?: unknown) => {
  const res = await fetch(base + url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
};

await test("reading a project never opens the window; a write is refused when it is off, for what it cannot do, or for a stranger", async () => {
  const read = await call("GET", `/api/opencut/${S}/project`);
  assert.equal(read.status, 200);
  assert.equal(read.body.state, null, "no window, no project to show");
  assert.equal(opencut.opencutState(S).open, false, "and the read did not open one");
  assert.equal((await call("GET", `/api/opencut/nosuchchat/project`)).status, 404);
  assert.equal((await call("POST", `/api/opencut/${S}/panel`, { bind: "video.clip", value: "x" })).status, 400, "the picked clip is the canvas's");
  assert.equal((await call("POST", `/api/opencut/${S}/panel`, { bind: "bpm", value: 1 })).status, 400);
  off = true;
  assert.equal((await call("POST", `/api/opencut/${S}/panel`, { bind: "video.speed", value: 2 })).status, 403);
  off = false;
  assert.equal(opencut.opencutState(S).open, false, "a refused write opens nothing");
  assert.equal((await call("POST", "/api/opencut/nosuchchat/panel", { bind: "video.speed", value: 2 })).status, 404);
});

server.close();
console.log(`\n${passed} panacea-video tests passed`);
process.exit(0);
