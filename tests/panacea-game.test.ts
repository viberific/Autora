/**
 * Panacea's Game panels (docs/PANACEA-GAPS.md, G1): a `game.*` control reads the game in Autora Games and changes the
 * movement behaviour of the object picked in the panel. The pure adapter (reads, writes, refusals), the route a panel's
 * change goes through (when the editor is built), gamePanel and the agent's panacea_set, and the recipes (each wired,
 * none a placebo).
 *
 *   npx tsx tests/panacea-game.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import starter from "../server/game-starter.json";

process.env.AUTORA_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "autora-panacea-game-"));

const express = (await import("express")).default;
const game = await import("../src/lib/panacea/apps/game");
const { BUILTINS } = await import("../src/lib/panacea/library");
const { treeLive, unwiredBinds } = await import("../src/lib/panacea/wiring");
const desk = await import("../server/gamedesk");
const panacea = await import("../server/panacea");

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

const platformer = () => ({ name: "Behavior", type: "PlatformBehavior::PlatformerObjectBehavior", maxSpeed: 250, jumpSpeed: 600, gravity: 1000, deceleration: 1500, acceleration: 1500 });
const topDown = () => ({ name: "Behavior", type: "TopDownMovementBehavior::TopDownMovementBehavior", maxSpeed: 200, deceleration: 800, acceleration: 400 });
/** A game with a platformer player and a top-down ghost, and a rock that does not move. */
const project = (): any => {
  const p = JSON.parse(JSON.stringify(starter));
  p.layouts[0].objects.push({ name: "Rock", type: "Sprite", behaviors: [] }, { name: "Player", type: "Sprite", behaviors: [platformer()] });
  p.objects.push({ name: "Ghost", type: "Sprite", behaviors: [topDown()] });
  return p;
};

await test("what a control shows is read off the object it acts on: the one picked, else the first that moves", () => {
  const p = project();
  assert.deepEqual(game.gameOptions(p).map((o) => o.value), ["Player", "Ghost"], "the rock does not move, so it is not offered");
  assert.equal(game.readGame(p, "game.object"), "Player");
  assert.equal(game.readGame(p, "game.object", "Ghost"), "Ghost");
  assert.equal(game.readGame(p, "game.object", "Rock"), "Player", "one that does not move falls back to the first that does");
  assert.equal(game.readGame(p, "game.speed"), 250);
  assert.equal(game.readGame(p, "game.jump"), 600);
  assert.equal(game.readGame(p, "game.gravity"), 1000);
  assert.equal(game.readGame(p, "game.friction"), 25, "1500 of 2000 braking is 25% slippery");
  assert.equal(game.readGame(p, "game.speed", "Ghost"), 200);
  assert.equal(game.readGame(p, "game.jump", "Ghost"), undefined, "a top-down mover has no jump");
  assert.equal(game.readGame(starter, "game.speed"), undefined, "no mover, nothing to show");
});

await test("a value changes the behaviour, and slippery is the braking read back", () => {
  const p = project();
  assert.deepEqual(game.writeGame(p, "game.speed", 400), { did: "Player runs at 400" });
  game.writeGame(p, "game.jump", 900); game.writeGame(p, "game.gravity", 2000);
  const b = p.layouts[0].objects[1].behaviors[0];
  assert.equal(b.maxSpeed, 400); assert.equal(b.jumpSpeed, 900); assert.equal(b.gravity, 2000);
  for (const slippery of [0, 40, 100]) { game.writeGame(p, "game.friction", slippery); assert.equal(game.readGame(p, "game.friction"), slippery); }
  assert.equal(b.deceleration, 0, "fully slippery never brakes");
  game.writeGame(p, "game.speed", 5000);
  assert.equal(b.maxSpeed, 1000, "held to the range");
  game.writeGame(p, "game.speed", 90, "Ghost");
  assert.equal(p.objects[0].behaviors[0].maxSpeed, 90);
  assert.equal(b.maxSpeed, 1000, "the other object is untouched");
});

await test("what the behaviour cannot do is refused with a reason, and the game is not changed", () => {
  const p = project();
  const before = JSON.stringify(p);
  for (const [bind, v, picked] of [["game.jump", 500, "Ghost"], ["game.gravity", 500, "Ghost"], ["game.speed", "fast", undefined], ["game.nope", 1, undefined], ["game.object", "x", undefined]] as const) {
    assert.ok("error" in game.writeGame(p, bind, v as never, picked), bind);
  }
  assert.equal(JSON.stringify(p), before);
  assert.match((game.writeGame(starter && JSON.parse(JSON.stringify(starter)), "game.speed", 5) as { error: string }).error, /no object in the game moves/);
});

await test("every Game recipe is wired, and nothing the game cannot do is offered", () => {
  const recipes = BUILTINS.filter((r) => r.domain === "game");
  assert.equal(recipes.length, 10);
  for (const r of recipes) {
    assert.equal(treeLive(r.tree), true, `${r.id}: ${unwiredBinds(r.tree).join(", ")}`);
    const walk = (n: { bind?: string; children?: unknown[] }) => { if (n.bind?.startsWith("game.")) assert.ok(game.GAME_WIRED.includes(n.bind), `${r.id}: ${n.bind}`); (n.children as typeof n[] | undefined)?.forEach(walk); };
    walk(r.tree);
  }
  for (const gone of ["camera", "health", "spawner", "score", "controls", "sound", "difficulty", "time", "particles", "sprite", "world"]) assert.equal(recipes.some((r) => r.id === `game.${gone}`), false, gone);
});

const S = "panelgame1";
await test("gamePanel changes the game, opens the window, and the window takes it quietly for a person", () => {
  assert.ok(desk.loadGame(S, Buffer.from(JSON.stringify(project()))).ok);
  const rev = desk.gameState(S).rev ?? 0;
  const out = desk.gamePanel(S, "game.jump", 800, "Player", "person");
  assert.ok(out.ok, JSON.stringify(out));
  const state = desk.gameState(S);
  assert.equal(state.open, true);
  assert.equal(state.by, "agent", "the editor takes it");
  assert.equal(state.quiet, state.rev, "but without moving the camera");
  assert.ok((state.rev ?? 0) > rev);
  assert.equal(game.readGame(desk.gameProject(S), "game.jump"), 800);
  assert.equal(desk.gamePanel(S, "game.jump", 800, "Ghost", "person").ok, false);
  assert.equal(desk.gamePanel(S, "game.object", "x", null, "person").ok, false, "the picked object is the canvas's");
  assert.equal(desk.gamePanel(S, "game.jump", 7, null, "agent").ok, true);
  assert.notEqual(desk.gameState(S).quiet, desk.gameState(S).rev, "an agent's own change is not quiet");
});

await test("the agent's panacea_set changes the game, and the canvas is described from the game", async () => {
  const hooks = {} as never;
  const placed = await panacea.runPanaceaTool(S, "panacea_place", { recipe: "game.physics", why: "to tune the fall" }, hooks);
  assert.ok(placed.ok, placed.summary);
  const set = await panacea.runPanaceaTool(S, "panacea_set", { values: { "game.object": "Player", "game.gravity": 1800 } }, hooks);
  assert.ok(set.ok, set.summary);
  assert.equal(game.readGame(desk.gameProject(S), "game.gravity"), 1800);
  const look = await panacea.runPanaceaTool(S, "panacea_look", {}, hooks);
  assert.match(look.summary, /game\.gravity=1800/);
  const bad = await panacea.runPanaceaTool(S, "panacea_set", { values: { "game.object": "Ghost", "game.gravity": 100 } }, hooks);
  assert.match(bad.summary, /Not set: game\.gravity: Ghost moves top-down and has no gravity/, "the object was picked, the gravity was refused");
  assert.equal(game.readGame(desk.gameProject(S), "game.gravity", "Player"), 1800);
  const off = await panacea.runPanaceaTool(S, "panacea_set", { values: { "game.speed": 10 } }, { windowOff: () => true } as never);
  assert.equal(off.ok, false);
  assert.match(off.summary, /switched off/);
});

if (desk.gameAvailable()) {
  const app = express();
  let off = false;
  desk.gameRoutes(app, { exists: (id) => id === S, incognito: () => false, off: () => off });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = async (url: string, body: unknown) => { const r = await fetch(base + url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, body: (await r.json().catch(() => null)) as any }; };
  await test("the route changes the game, refuses what it cannot take, does nothing on GET, and refuses when Games is off", async () => {
    assert.equal((await post(`/api/game/${S}/panel`, { bind: "game.speed", value: 333, object: "Player" })).status, 200);
    assert.equal(game.readGame((await (await fetch(`${base}/api/game/${S}/project`)).json() as { project: unknown }).project, "game.speed"), 333);
    assert.equal((await post(`/api/game/${S}/panel`, { bind: "game.speed", value: "x" })).status, 400);
    assert.notEqual((await fetch(`${base}/api/game/${S}/panel`)).status, 200);
    off = true;
    assert.equal((await post(`/api/game/${S}/panel`, { bind: "game.speed", value: 1 })).status, 403);
    off = false;
    assert.equal((await post("/api/game/nosuchchat/panel", { bind: "game.speed", value: 1 })).status, 404);
  });
  server.close();
} else console.log("  skip  the route test needs the game editor built (npm --prefix gdevelop-editor run build)");

console.log(`\n${passed} panacea-game tests passed`);
process.exit(0);
