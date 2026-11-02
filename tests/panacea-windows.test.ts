/**
 * App windows on the canvas (docs/PANACEA-GAPS.md, G2): where each is, kept with the canvas, and laid out by the agent
 * as a person lays them out by hand. The pure layout (places, raising, maximising, tidying), the canvas keeping them,
 * and the agent's panacea_arrange on windows and surfaces.
 *
 *   npx tsx tests/panacea-windows.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AUTORA_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "autora-panacea-windows-"));

const win = await import("../src/lib/panacea/windows");
const { newCanvas, normalizeCanvas, describeCanvas } = await import("../src/lib/panacea/canvas");
const panacea = await import("../server/panacea");

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}
const overlap = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

await test("a window is named the way a person names it: its app, its title, or its id", () => {
  assert.equal(win.windowNamed("Music"), "engine:studio");
  assert.equal(win.windowNamed("studio"), "engine:studio");
  assert.equal(win.windowNamed("3D"), "engine:cad");
  assert.equal(win.windowNamed("engine:video"), "engine:video");
  assert.equal(win.windowNamed("Canvas"), null, "the canvas is not a window on itself");
  assert.equal(win.windowNamed("nothing"), null);
  assert.equal(win.windowTitle("engine:game"), "Games");
});

await test("a place is set, held to a size a window can be, and raised over the rest", () => {
  const wins: import("../src/lib/panacea/windows").WinBox[] = [];
  const a = win.placeWindow(wins, "engine:studio", { x: 10, y: 20, w: 900, h: 600 })!;
  const b = win.placeWindow(wins, "engine:cad", { x: 0, y: 0 })!;
  assert.deepEqual([a.x, a.y, a.w, a.h], [10, 20, 900, 600]);
  assert.equal(b.w, 1056, "a new window takes the usual size");
  assert.ok(b.z > a.z, "the newer is in front");
  assert.equal(win.placeWindow(wins, "engine:studio", { w: 5, h: 5 })!.w, win.WIN_MIN.w, "never smaller than an app can show itself");
  assert.equal(win.placeWindow(wins, "engine:panacea", { x: 1 }), null, "not a window");
  assert.equal(win.raise(wins, "engine:studio"), true);
  assert.ok(a.z > b.z);
  assert.equal(win.raise(wins, "engine:studio"), false, "already in front: nothing to write");
});

await test("maximising keeps what it was and gives it back, and sizing by hand lets go of it", () => {
  const wins: import("../src/lib/panacea/windows").WinBox[] = [];
  win.placeWindow(wins, "engine:studio", { x: 100, y: 50, w: 700, h: 500 });
  assert.equal(win.maximise(wins, "engine:studio", { w: 390, h: 600 }, 8), "maximised");
  assert.deepEqual([wins[0]!.x, wins[0]!.y, wins[0]!.w, wins[0]!.h], [100, 50, 374, 584]);
  assert.deepEqual(wins[0]!.was, { x: 100, y: 50, w: 700, h: 500 });
  assert.equal(win.maximise(wins, "engine:studio", { w: 390, h: 600 }, 8, "max"), "maximised", "again, when asked to maximise, changes nothing more");
  assert.equal(win.maximise(wins, "engine:studio", { w: 390, h: 600 }, 8, "restore"), "restored");
  assert.deepEqual([wins[0]!.x, wins[0]!.y, wins[0]!.w, wins[0]!.h], [100, 50, 700, 500]);
  assert.equal(wins[0]!.was, undefined);
  assert.equal(win.maximise(wins, "engine:studio", { w: 390, h: 600 }, 8, "restore"), null, "nothing to give back");
  assert.equal(win.maximise(wins, "engine:cad", { w: 1, h: 1 }), null, "no such window here");
});

await test("tidy lays boxes in rows with a gap, none over another, and keeps their sizes and order", () => {
  const items = [
    { id: "a", x: 0, y: 0, w: 1056, h: 740 }, { id: "b", x: 200, y: 100, w: 1056, h: 740 }, { id: "c", x: 300, y: 150, w: 640, h: 480 },
    { id: "d", x: -1200, y: 920, w: 1056, h: 740 }, { id: "e", x: 20, y: 40, w: 280, h: 180 },
  ];
  const spots = win.tidy(items, { width: 2400 });
  assert.equal(spots.size, items.length);
  const placed = items.map((i) => ({ ...i, ...spots.get(i.id)! }));
  for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) assert.equal(overlap(placed[i]!, placed[j]!), false, `${placed[i]!.id} over ${placed[j]!.id}`);
  assert.ok(placed.every((p) => p.x + p.w <= Math.min(...items.map((i) => i.x), 0) + 2400 || p.x === Math.min(...placed.map((q) => q.x))), "a row ends before it is wider than asked");
  assert.deepEqual(win.tidy([], {}).size, 0);
});

await test("the canvas keeps its windows and the room, and reads back only what is sound", () => {
  const c = newCanvas("Layout");
  c.windows = [{ id: "engine:studio", x: 10, y: 20, w: 900, h: 600, z: 2, was: { x: 0, y: 0, w: 500, h: 400 } }, { id: "engine:cad", x: -1200, y: 0, w: 640, h: 480, z: 1 }];
  c.room = { w: 1200, h: 700 };
  const back = normalizeCanvas(JSON.parse(JSON.stringify(c)))!;
  assert.deepEqual(back.windows, c.windows);
  assert.deepEqual(back.room, c.room);
  const bad = normalizeCanvas({ ...JSON.parse(JSON.stringify(c)), windows: [{ id: "engine:nope", x: 1, y: 1, w: 500, h: 400 }, { id: "engine:studio", x: "a", y: 3, w: 9e9, h: 10 }, { id: "engine:studio", x: 1, y: 1, w: 500, h: 400 }, "x"], room: { w: 5, h: 5 } })!;
  assert.equal(bad.windows!.length, 1, "an unknown window, a repeat and a non-window are dropped");
  assert.deepEqual([bad.windows![0]!.x, bad.windows![0]!.w, bad.windows![0]!.h], [0, 8000, 120], "and the numbers are held to what is possible");
  assert.equal(bad.room, undefined, "a room too small to be one is not kept");
  assert.match(describeCanvas(c), /Windows \(front first\): Music 900x600 at 10,20 \(maximised\); 3D 640x480 at -1200,0\./);
});

const express = (await import("express")).default;
const S = "winlayout1";
const app = express();
panacea.panaceaRoutes(app, { exists: (id) => id === S, incognito: () => false, off: () => false, push: () => undefined });
const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const call = async (method: string, url: string, body?: unknown) => {
  const res = await fetch(base + url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
};
const canvas = async () => (await call("GET", `/api/panacea/${S}/doc`)).body.doc as import("../src/lib/panacea/canvas").Canvas;
const hooks = {} as never;
const arrange = (args: Record<string, unknown>) => panacea.runPanaceaTool(S, "panacea_arrange", args, hooks);
const box = (c: import("../src/lib/panacea/canvas").Canvas, id: string) => c.windows!.find((w) => w.id === id)!;

await test("the page's layout is kept with the canvas (and a window with no place is refused, not guessed)", async () => {
  const c = newCanvas("Layout");
  c.windows = [{ id: "engine:studio", x: 0, y: 0, w: 800, h: 600, z: 1 }, { id: "engine:cad", x: -1200, y: 0, w: 640, h: 480, z: 2 }];
  c.room = { w: 1000, h: 700 };
  assert.equal((await call("PUT", `/api/panacea/${S}/doc`, { doc: c })).status, 200);
  assert.deepEqual((await canvas()).windows, c.windows, "what the page wrote is what a reload reads");
  const none = await arrange({ windows: [{ window: "Video", do: "front" }] });
  assert.equal(none.ok, false);
  assert.match(none.summary, /Video window is not open on this canvas yet/);
  assert.equal((await arrange({ windows: [{ window: "Toaster", x: 1, y: 1 }] })).ok, false);
  assert.equal((await arrange({ windows: [{ window: "Music", do: "sideways" }] })).ok, false);
});

await test("the agent moves and sizes a window, and it comes to the front", async () => {
  const out = await arrange({ windows: [{ window: "3D", x: 400, y: 100, w: 700, h: 500 }] });
  assert.ok(out.ok, out.summary);
  const c = await canvas();
  assert.deepEqual([box(c, "engine:cad").x, box(c, "engine:cad").y, box(c, "engine:cad").w, box(c, "engine:cad").h], [400, 96, 704, 496], "on the grid, as a person's drag lands");
  assert.deepEqual([box(c, "engine:studio").x, box(c, "engine:studio").w], [0, 800], "the other window is untouched");
  const front = await arrange({ windows: [{ window: "Music", do: "front" }] });
  assert.ok(front.ok, front.summary);
  assert.match(front.summary, /brought the Music window to the front/);
  const c2 = await canvas();
  assert.ok(box(c2, "engine:studio").z > box(c2, "engine:cad").z);
});

await test("the agent maximises to the room the page measured, and gives it back", async () => {
  const before = box(await canvas(), "engine:studio");
  const max = await arrange({ windows: [{ window: "Music", do: "maximise" }] });
  assert.ok(max.ok, max.summary);
  const m = box(await canvas(), "engine:studio");
  assert.deepEqual([m.w, m.h], [968, 668], "the room less a margin each side");
  assert.deepEqual([m.x, m.y], [before.x, before.y], "where it was: the view goes to it");
  assert.deepEqual([m.was!.w, m.was!.h], [before.w, before.h]);
  const back = await arrange({ windows: [{ window: "Music", do: "restore" }] });
  assert.match(back.summary, /restored the Music window/);
  assert.deepEqual([box(await canvas(), "engine:studio").w, box(await canvas(), "engine:studio").h], [before.w, before.h]);
});

await test("the agent moves and sizes a surface, and tidies the lot into rows with none over another", async () => {
  const c = await canvas();
  const surface = await panacea.runPanaceaTool(S, "panacea_surface", { board: "Ideas" }, hooks);
  assert.ok(surface.ok, surface.summary);
  const id = (await canvas()).surfaces[0]!.id;
  const moved = await arrange({ surfaces: [{ id, x: 64, y: 32, w: 400, h: 300 }] });
  assert.ok(moved.ok, moved.summary);
  const s = (await canvas()).surfaces[0]!;
  assert.deepEqual([s.x, s.y, s.w, s.h], [64, 32, 400, 304]);
  assert.equal((await arrange({ surfaces: [{ id: "nope", x: 1 }] })).ok, false);
  const tidy = await arrange({ tidy: "all" });
  assert.ok(tidy.ok, tidy.summary);
  const t = await canvas();
  const items = [...t.windows!.map((w) => ({ id: w.id, x: w.x, y: w.y, w: w.w, h: w.h })), ...t.surfaces.map((x) => ({ id: x.id, x: x.x, y: x.y, w: x.w, h: x.h }))];
  assert.equal(items.length, 3);
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) assert.equal(overlap(items[i]!, items[j]!), false, `${items[i]!.id} over ${items[j]!.id}`);
  assert.equal(box(t, "engine:studio").was, undefined, "a tidied window is no longer 'maximised'");
  assert.equal((await arrange({ tidy: "windows" })).ok, true);
  void c;
});

await test("what the agent reads says where the windows are", async () => {
  const look = await panacea.runPanaceaTool(S, "panacea_look", {}, hooks);
  assert.match(look.summary, /Windows \(front first\): /);
  assert.match(look.summary, /Music \d+x\d+ at -?\d+,-?\d+/);
});

server.close();
console.log(`\n${passed} panacea-windows tests passed`);
process.exit(0);
