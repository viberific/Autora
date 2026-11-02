/**
 * Panacea's Music panels (docs/PANACEA-GAPS.md, G1): a `music.*` control reads the song in Autora Music and writes to it.
 * The pure adapter (round trips, the drum grid, refusals), the route a panel's change goes through (it changes the song,
 * opens the window, refuses when Music is off), the agent's panacea_set, and the recipes (each wired, none a placebo).
 *
 *   npx tsx tests/panacea-music.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AUTORA_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "autora-panacea-music-"));

const express = (await import("express")).default;
const model = await import("../src/lib/studio/model");
const music = await import("../src/lib/panacea/apps/music");
const { BUILTINS } = await import("../src/lib/panacea/library");
const { treeLive, unwiredBinds } = await import("../src/lib/panacea/wiring");
const studio = await import("../server/studio");
const panacea = await import("../server/panacea");

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}
const write = (p: ReturnType<typeof model.newProject>, bind: string, v: unknown, picked?: unknown) => music.writeMusic(p, bind, v as never, picked);
const song = () => {
  const p = model.newProject("Panel song");
  p.tracks.push(model.newTrack(p, "keys", "Keys"));
  p.tracks.push(model.newTrack(p, "bass", "Bass"));
  return p;
};

// ------------------------------------------------------------- the adapter --

await test("song values round trip through the panel's scale", () => {
  const p = song();
  for (const [bind, v] of [["music.bpm", 123], ["music.sig", "6/8"], ["music.loop", true], ["music.root", "F#"], ["music.scale", "dorian"], ["music.master", 80]] as const) {
    assert.ok(!("error" in write(p, bind, v)), bind);
    assert.equal(music.readMusic(p, bind), v, bind);
  }
  assert.equal(p.beatsPerBar, 6);
  assert.equal(p.key.root, 6);
  for (const s of model.SCALE_NAMES) { write(p, "music.scale", s); assert.equal(music.readMusic(p, "music.scale"), s); }
});

await test("track values act on the picked track, else the open clip's, else the first", () => {
  const p = song();
  const [keys, bass] = p.tracks;
  write(p, "music.vol", 40, bass!.id);
  write(p, "music.pan", -25, bass!.id);
  write(p, "music.reverb", 30, bass!.id);
  write(p, "music.low", 3.3, bass!.id);
  assert.equal(bass!.volume, 0.4);
  assert.equal(bass!.pan, -0.5);
  assert.equal(bass!.reverb, 0.3);
  assert.equal(bass!.eq.low, 3.5, "half-decibel steps");
  assert.equal(music.readMusic(p, "music.vol", bass!.id), 40);
  assert.equal(music.readMusic(p, "music.pan", bass!.id), -25);
  assert.notEqual(keys!.volume, 0.4, "the other track is untouched");
  assert.equal(music.musicTrack(p, "nope", bass!.id), bass);
  assert.equal(music.musicTrack(p, "nope", null), keys);
  write(p, "music.solo", true);
  assert.equal(keys!.solo, true, "no pick, no focus: the first track");
  assert.deepEqual(music.musicOptions(p).map((o) => o.label), ["Keys", "Bass"]);
});

await test("the drum grid reads and writes the first drum track, and makes one if there is none", () => {
  const p = song();
  const grid = Array.from({ length: 64 }, () => 0);
  for (const col of [0, 4, 8, 12]) grid[col] = 1; // kick
  for (const col of [4, 12]) grid[16 + col] = 1; // snare
  for (let col = 0; col < 16; col += 2) grid[32 + col] = 1; // hat
  const done = write(p, "music.steps", grid);
  assert.ok("did" in done, JSON.stringify(done));
  const kit = p.tracks.find((t) => t.instrument === "kit")!;
  assert.ok(kit, "a Drums track was made");
  assert.equal(kit.clips.length, 1);
  assert.equal(kit.clips[0]!.name, "Beat");
  assert.deepEqual(music.readMusic(p, "music.steps"), grid);
  assert.deepEqual(kit.clips[0]!.notes.filter((n) => n.pitch === 36).map((n) => n.start), [0, 1, 2, 3]);
  grid[0] = 0; grid[1] = 1;
  write(p, "music.steps", grid);
  assert.deepEqual(music.readMusic(p, "music.steps"), grid, "a step turned off and another on");
  assert.equal(p.tracks.filter((t) => t.instrument === "kit").length, 1, "no second drum track");
  assert.deepEqual(music.readMusic(model.newProject(), "music.steps"), Array.from({ length: 64 }, () => 0));
});

await test("an instrument change refuses to cross drums and tuned sounds on a track with notes", () => {
  const p = song();
  const keys = p.tracks[0]!;
  assert.ok(!("error" in write(p, "music.inst", "kit", keys.id)), "an empty track may become drums");
  assert.equal(keys.instrument, "kit");
  write(p, "music.inst", "keys", keys.id);
  const clip = model.newClip(0, 4, "Clip");
  clip.notes.push({ id: "n1", pitch: 60, start: 0, length: 1, vel: 0.8 });
  keys.clips.push(clip);
  const refused = write(p, "music.inst", "kit", keys.id);
  assert.ok("error" in refused);
  assert.match((refused as { error: string }).error, /add a new track/);
  assert.equal(keys.instrument, "keys");
  assert.ok(!("error" in write(p, "music.inst", "pluck", keys.id)), "tuned to tuned is fine");
});

await test("a value that does not fit is refused, and the song is not changed", () => {
  const p = song();
  const before = JSON.stringify(p);
  for (const [bind, v] of [["music.bpm", "fast"], ["music.sig", "9/16"], ["music.root", "H"], ["music.scale", "lydian-ish"], ["music.vol", null], ["music.inst", "banjo"], ["music.steps", "x"], ["music.nope", 1]] as const) {
    assert.ok("error" in write(p, bind, v), bind);
  }
  assert.equal(JSON.stringify(p), before);
  assert.ok("error" in write(model.newProject(), "music.vol", 50), "a song with no tracks has no track to move");
  write(p, "music.bpm", 9999);
  assert.equal(p.bpm, model.MAX_BPM);
});

// ----------------------------------------------------------------- recipes --

await test("every Music recipe is wired: it is offered, and nothing in it is a placebo", () => {
  const recipes = BUILTINS.filter((r) => r.domain === "music");
  assert.ok(recipes.length >= 12);
  for (const r of recipes) {
    assert.equal(treeLive(r.tree), true, `${r.id}: ${unwiredBinds(r.tree).join(", ")}`);
    const binds: string[] = [];
    const walk = (n: { bind?: string; children?: unknown[] }) => { if (n.bind?.startsWith("music.")) binds.push(n.bind); (n.children as typeof n[] | undefined)?.forEach(walk); };
    walk(r.tree);
    for (const b of binds) assert.ok(music.isMusicBind(b), `${r.id}: ${b} is not something the song answers to`);
  }
  for (const gone of ["arrange", "envelope", "filter", "compressor", "groove", "pad", "arp"]) assert.equal(recipes.some((r) => r.id === `music.${gone}`), false, gone);
});

// ------------------------------------------------------------------ route --

const S = "panelmusic1";
let off = false;
const app = express();
studio.studioRoutes(app, { exists: (id) => id === S, incognito: () => false, off: () => off, push: () => undefined });
const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const call = async (method: string, url: string, body?: unknown) => {
  const res = await fetch(base + url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
};
const doc = async () => (await call("GET", `/api/studio/${S}/doc`)).body.doc as ReturnType<typeof model.newProject>;

await test("a panel's change goes to the song, opens the window and is not lit up for the person", async () => {
  assert.equal(studio.studioState(S).open, false);
  const out = await call("POST", `/api/studio/${S}/panel`, { bind: "music.bpm", value: 101 });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal((await doc()).bpm, 101);
  const state = studio.studioState(S);
  assert.equal(state.open, true);
  assert.equal(state.by, "agent", "the window reloads on this");
  assert.equal(state.quiet, state.rev, "but without lighting up");
});

await test("the route refuses what the song cannot take, and does nothing on GET, and refuses when Music is off", async () => {
  const bad = await call("POST", `/api/studio/${S}/panel`, { bind: "music.bpm", value: "fast" });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /number/);
  assert.equal((await call("POST", `/api/studio/${S}/panel`, { bind: "music.track", value: "x" })).status, 400, "the picked track is the canvas's, not the song's");
  assert.equal((await call("POST", `/api/studio/${S}/panel`, { bind: "bpm", value: 1 })).status, 400);
  const rev = studio.studioState(S).rev;
  assert.equal((await call("GET", `/api/studio/${S}/panel`)).status === 200, false);
  assert.equal(studio.studioState(S).rev, rev);
  off = true;
  assert.equal((await call("POST", `/api/studio/${S}/panel`, { bind: "music.bpm", value: 77 })).status, 403);
  off = false;
  assert.equal((await doc()).bpm, 101);
  assert.equal((await call("POST", "/api/studio/nosuchchat/panel", { bind: "music.bpm", value: 77 })).status, 404);
});

await test("a track control follows the track the panel picked", async () => {
  const p = await doc();
  assert.equal(p.tracks.length, 0);
  assert.equal((await call("POST", `/api/studio/${S}/panel`, { bind: "music.vol", value: 50 })).status, 400, "no tracks yet");
  const made = await studio.runStudioTool(S, "studio_track", { action: "add", instrument: "keys", name: "Keys" });
  assert.ok(made.ok, made.summary);
  await studio.runStudioTool(S, "studio_track", { action: "add", instrument: "bass", name: "Bass" });
  const tracks = (await doc()).tracks;
  assert.equal(tracks.length, 2);
  const res = await call("POST", `/api/studio/${S}/panel`, { bind: "music.vol", value: 35, track: tracks[1]!.id });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const after = (await doc()).tracks;
  assert.equal(after[1]!.volume, 0.35);
  assert.notEqual(after[0]!.volume, 0.35);
});

// ------------------------------------------------------------------ agent --

await test("the agent's panacea_set changes the song, and the canvas is described from the song", async () => {
  const hooks = {} as never;
  const placed = await panacea.runPanaceaTool(S, "panacea_place", { recipe: "music.transport", why: "to set the tempo" }, hooks);
  assert.ok(placed.ok, placed.summary);
  const set = await panacea.runPanaceaTool(S, "panacea_set", { values: { "music.bpm": 140, "music.loop": true } }, hooks);
  assert.ok(set.ok, set.summary);
  const p = await doc();
  assert.equal(p.bpm, 140);
  assert.equal(p.loop, true);
  const look = await panacea.runPanaceaTool(S, "panacea_look", {}, hooks);
  assert.match(look.summary, /music\.bpm=140/);
  const bad = await panacea.runPanaceaTool(S, "panacea_set", { values: { "music.bpm": "fast" } }, hooks);
  assert.equal(bad.ok, false);
  assert.equal((await doc()).bpm, 140);
});

server.close();
console.log(`\n${passed} panacea-music tests passed`);
process.exit(0);
