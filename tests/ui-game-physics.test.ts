/**
 * The bridge from Autora 3D to Autora Games, in a real browser with GDevelop's real editor and engine: a shape modelled in
 * the 3D window becomes a 3D object in the game with real rigid-body physics (GDevelop's Physics3D, on Jolt), and it falls
 * and lands on the floor the bridge adds. The game says its height (z) in its page title every frame, so the test reads
 * the physics as it runs, not a picture. Then the object follows the model (a taller shape makes a taller object, its
 * physics kept), and the person's own path, the 3D window's Send to the game, makes a second object that stays put.
 *
 * Needs the app, the 3D modeller and the game editor built (npm run build); skips without them or a browser.
 *
 *   npx tsx tests/ui-game-physics.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { chromium, type Frame } from "playwright-core";
import { sleep, startApp } from "./e2e-harness";
import { CHROME } from "./chrome";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}


async function waitFor(what: string, ok: () => Promise<boolean>, ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await ok().catch(() => false)) return;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}`);
}

type Json = any;

async function main() {
  const exe = CHROME;
  if (!fs.existsSync(exe)) { console.log("  skip  no browser here"); return; }
  for (const built of ["dist/gdevelop-editor/index.html", "dist/autora-3d/index.html", "dist/autora-3d-engine/engine.mjs"]) {
    if (!fs.existsSync(built)) { console.log(`  skip  ${built} is not built (npm run build)`); return; }
  }
  const app = await startApp();
  const browser = await chromium.launch({ executablePath: exe, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  try {
    const s = await app.newSession("A barrel that falls", "build");
    const project = async () => (await app.api("GET", `/api/game/${s}/project`)).body.project as Json;
    const scene = async () => (await project()).layouts[0];
    const byName = (list: Json[], name: string) => list.find((o: Json) => o.name === name);
    const say = async (text: string, tools: Array<{ name: string; args: Record<string, unknown> }>) => {
      // One call a step, in order, as an agent working through it does (calls in one step may run side by side).
      let n = 0;
      app.decide = () => (n < tools.length ? { tools: [tools[n++]!] } : { text: "Done." });
      await app.turn(s, text, 240_000);
      app.decide = null;
      return app.seen.map((r) => JSON.stringify(r.messages.filter((m) => m.role === "tool"))).join("\n").replace(/\\+"/g, '"');
    };

    // A readout the game writes every frame: the barrel's height, in the page's title.
    const readout = {
      type: "BuiltinCommonInstructions::Standard",
      conditions: [],
      actions: [{ type: { value: "SetWindowTitle" }, parameters: ["", '"z=" + ToString(round(Barrel.Object3D::Z())) + ";w=" + ToString(round(Barrel.Width())) + ";h=" + ToString(round(Barrel.Height())) + ";d=" + ToString(round(Barrel.Object3D::Depth())) + ";cz=" + ToString(round(Barrel.Object3D::CenterZ())) + ";rx=" + ToString(round(Barrel.Object3D::RotationX())) + ";ry=" + ToString(round(Barrel.Object3D::RotationY())) + ";gz=" + ToString(round(Ground.Object3D::Z())) + ";gd=" + ToString(round(Ground.Object3D::Depth())) + ";gcz=" + ToString(round(Ground.Object3D::CenterZ()))'], subInstructions: [] }],
      events: [],
    };

    const out = await say("model a bouncy barrel and drop it in a game", [
      { name: "cad_shape_add", args: { kind: "cylinder", width: 40, height: 60, name: "Barrel", color: "#b45309" } },
      { name: "game_from_model", args: { shapes: ["Barrel"], object: "Barrel", physics: { feel: ["bouncy"], body: "dynamic", shape: "cylinder" }, ground: true, place: { x: 400, y: 300, z: 300 } } },
      { name: "game_edit", args: { ops: [{ op: "insert", path: "layouts[Scene].events", value: readout }] } },
    ]);

    await test("the 3D model becomes a 3D object in the game, with physics, a floor and the scene's physics world", async () => {
      const said = /call_\d+_1","content":"([^]{0,600})/.exec(out)?.[1] ?? out.slice(-600);
      assert.match(out, /made the 3D object Barrel/, said);
      assert.match(out, /made the 3D object Barrel from the model "Barrel"/);
      assert.match(out, /gave Barrel dynamic physics \(cylinder/);
      const layout = await scene();
      const barrel = byName(layout.objects, "Barrel");
      assert.equal(barrel.type, "Scene3D::Model3DObject");
      assert.deepEqual([barrel.content.width, barrel.content.height, barrel.content.depth], [40, 40, 60], "its mm as pixels");
      const physics = barrel.behaviors.find((b: Json) => b.type === "Physics3D::Physics3DBehavior");
      assert.equal(physics.bodyType, "Dynamic");
      assert.equal(physics.object3D, "Object3D");
      assert.ok(physics.restitution > 0.8, "bouncy");
      const ground = byName(layout.objects, "Ground");
      assert.equal(ground.behaviors[0].bodyType, "Static");
      assert.ok(layout.behaviorsSharedData.some((d: Json) => d.name === "Physics3D" && d.gravityZ === -9.8));
      const res = (await project()).resources.resources.find((r: Json) => r.name === barrel.content.modelResourceName);
      assert.equal(res.kind, "model3D");
      const glb = await fetch(`${app.base}${res.file}`);
      assert.equal(glb.status, 200);
      assert.equal(Buffer.from(await glb.arrayBuffer()).subarray(0, 4).toString(), "glTF", "the model as a GLB");
    });

    const context = await browser.newContext({ viewport: { width: 1500, height: 950 } });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    if (process.env.SHOT) page.on("console", (m) => { if (/error|warn|model|glb|gltf|resource/i.test(m.text())) console.log(`      console ${m.type()}: ${m.text().slice(0, 300)}`); });
    if (process.env.SHOT) page.on("requestfailed", (r) => console.log(`      failed: ${r.url()} ${r.failure()?.errorText}`));
    if (process.env.SHOT) page.on("response", (r) => { if (/assets\//.test(r.url())) console.log(`      asset ${r.status()} ${r.url()}`); });
    await page.goto(`${app.base}/?session=${s}`);
    const editor = (): Frame => {
      const f = page.frames().find((fr) => fr.url().includes("/gdevelop-editor/"));
      if (!f) throw new Error("the editor's frame is not there");
      return f;
    };
    await waitFor("the game editor", async () => (await editor().evaluate(() => document.body.innerText)).includes("Barrel"), 120_000);

    /** Plays the game in the window and reads the barrel's height off the title for a few seconds. */
    let lastTitle = "";
    const play = async (ms = 6000): Promise<number[]> => {
      await page.locator('.rail-bar button[aria-label="Play"]').click();
      let game: Frame | undefined;
      await waitFor("the game to start", async () => {
        game = page.frames().find((f) => /\/preview\/[0-9a-f]+\/preview\/index\.html$/.test(f.url()));
        return !!game && (await game.evaluate(() => document.title)).startsWith("z=");
      }, 90_000);
      const heights: number[] = [];
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const z = Number(/^z=(-?\d+)/.exec(await game!.evaluate(() => document.title))?.[1]);
        if (Number.isFinite(z)) heights.push(z);
        await sleep(100);
      }
      lastTitle = await game!.evaluate(() => document.title);
      console.log(`      heights: ${heights.filter((_, i) => i % 4 === 0).join(" ")}  (${lastTitle})`);
      if (process.env.SHOT) {
        const files = await game!.evaluate(async () => {
          const names = ["data.js", "data.json"];
          const out: string[] = [];
          for (const n of names) { const r = await fetch(location.href.replace("index.html", n)).catch(() => null); if (r && r.ok) { const t = await r.text(); out.push(n + ": " + (t.match(/"name":"Barrel"[^]{0,400}/)?.[0] ?? "").replace(/\s+/g, " ").slice(0, 400) + " || " + (t.match(/"file":"[^"]*Barrel[^"]*"/g) ?? []).join(",")); } }
          return out.join("\n");
        });
        console.log("      preview: " + files);
        const proj = (await project()).layouts[0].objects.find((o: Json) => o.name === "Barrel");
        console.log("      project: depth " + proj.content.depth + " res " + (await project()).resources.resources.filter((r: Json) => /Barrel/.test(r.name)).map((r: Json) => r.file).join(","));
      }
      if (process.env.SHOT) await page.screenshot({ path: `${process.env.SHOT}-${Date.now()}.png` });
      await editor().getByRole("button", { name: "Stop" }).click();
      await waitFor("the game to stop", async () => (await editor().locator("#autora-play").count()) === 0);
      return heights;
    };

    await test("in GDevelop's own engine the bouncy barrel falls, bounces off the floor and never goes through it", async () => {
      const heights = await play();
      const first = heights[0]!;
      assert.ok(first > 150, `it starts up high (${first})`);
      assert.ok(heights.some((z) => z < first - 150), "it falls");
      // The first time it touches down: the lowest point before it rises again.
      let bottom = 1;
      while (bottom < heights.length - 1 && !(heights[bottom]! <= heights[bottom - 1]! && heights[bottom + 1]! > heights[bottom]! + 5)) bottom++;
      assert.ok(Math.min(...heights) > -15, `the floor holds it (lowest ${Math.min(...heights)})`);
      assert.ok(Math.max(...heights.slice(bottom)) > heights[bottom]! + 50, `and it bounces back up (from ${heights[bottom]})`);
    });

    await test("it follows the model: a taller barrel in Autora 3D makes a taller object, and its physics stay", async () => {
      const id = ((await app.api("GET", `/api/cad/${s}/doc`)).body.doc.bodies as Json[]).find((b) => b.name === "Barrel")!.id;
      await say("make the barrel taller", [{ name: "cad_shape_set", args: { id, height: 90 } }]);
      await waitFor("the game to follow the model", async () => byName((await scene()).objects, "Barrel").content.depth === 90, 20_000);
      const barrel = byName((await scene()).objects, "Barrel");
      assert.ok(barrel.behaviors.find((b: Json) => b.type === "Physics3D::Physics3DBehavior").restitution > 0.8, "still bouncy");
      assert.equal((await scene()).instances.filter((i: Json) => i.name === "Barrel").length, 1, "and still placed once");
    });

    await test("the person's own way: Send to the game from the 3D window makes an object that stays put", async () => {
      await say("add a crate", [{ name: "cad_shape_add", args: { kind: "box", width: 50, depth: 50, height: 50, x: 120, name: "Crate" } }]);
      const crate = ((await app.api("GET", `/api/cad/${s}/doc`)).body.doc.bodies as Json[]).find((b) => b.name === "Crate")!.id;
      const sent = await app.api("POST", `/api/game/${s}/from-model`, { shapes: [crate], physics: "fixed" });
      assert.equal(sent.status, 200, JSON.stringify(sent.body));
      const made = byName((await scene()).objects, "Crate");
      const physics = made.behaviors.find((b: Json) => b.type === "Physics3D::Physics3DBehavior");
      assert.deepEqual([physics.bodyType, physics.shape, physics.meshShapeResourceName], ["Static", "Mesh", made.content.modelResourceName], "the exact model, staying put");
      const again = await app.api("POST", `/api/game/${s}/from-model`, { shapes: [crate], physics: "falls" });
      assert.equal(again.status, 400, "a mesh cannot move: it says so rather than making a broken body");
      assert.match(again.body.error, /mesh/);
      assert.equal((await scene()).objects.filter((o: Json) => o.name.startsWith("Crate")).length, 1, "the same shapes update one object, never a second");
    });

    await test("in the 3D window itself: Export & file, Falls, Send to the game, and the 3D window says it is in the game", async () => {
      const cadFrame = (): Frame => {
        const f = page.frames().find((fr) => fr.url().includes("/autora-3d/"));
        if (!f) throw new Error("the 3D window's frame is not there");
        return f;
      };
      await waitFor("the 3D window", async () => !!cadFrame(), 30_000);
      const before = (await scene()).objects.length;
      // The window may be off the board's camera: the buttons are pressed where they are (their own click handlers run).
      const press = async (loc: ReturnType<Frame["locator"]>) => { await loc.first().waitFor({ state: "attached" }); await loc.first().evaluate((el) => (el as HTMLElement).click()); };
      const bar = cadFrame().locator('nav[aria-label="Tools"]');
      const file = bar.locator('button[aria-label="Export & file"]');
      if (await file.count()) await press(file);
      else {
        await press(bar.locator('button[aria-label="All tools"]'));
        await press(cadFrame().locator('[role="dialog"][aria-label="All tools"] button', { hasText: "Export & file" }));
      }
      const card = cadFrame().locator('section[aria-label="Export & file options"]');
      await press(card.locator("button", { hasText: "Falls" }));
      await press(card.locator("button", { hasText: /Send (the pick )?to the game/ }));
      await waitFor("a new object in the game", async () => (await scene()).objects.length > before, 30_000);
      await waitFor("the 3D window to say so", async () => (await cadFrame().evaluate(() => document.body.innerText)).includes("In the game"), 15_000);
    });

    await test("Panacea's 3D physics panel moves the same numbers", async () => {
      const set = await app.api("POST", `/api/game/${s}/panel`, { bind: "game.bounce", value: 20, object: "Barrel" });
      assert.equal(set.status, 200, JSON.stringify(set.body));
      const physics = byName((await scene()).objects, "Barrel").behaviors.find((b: Json) => b.type === "Physics3D::Physics3DBehavior");
      assert.equal(physics.restitution, 0.2);
      assert.equal((await app.api("POST", `/api/game/${s}/panel`, { bind: "game.body", value: "flying", object: "Barrel" })).status, 400);
    });

    await test("with its bounce turned down in the panel, the barrel lands and comes to rest on the floor", async () => {
      await app.api("POST", `/api/game/${s}/panel`, { bind: "game.bounce", value: 0, object: "Barrel" });
      await waitFor("the editor to take the change", async () => true, 1000);
      await sleep(3000);
      const heights = await play(6000);
      const last = heights.at(-1)!;
      assert.ok(last > -15 && last < 40, `it rests on the floor (${last})`);
      assert.ok(heights.slice(-10).every((z) => Math.abs(z - last) < 4), "and stays there");
      assert.match(lastTitle, /;d=90;/, "and it is the taller model that plays: the game took the one the 3D window made");
    });

    assert.deepEqual(errors.filter((e) => !/ResizeObserver/.test(e)), [], `no page errors: ${errors.join(" | ").slice(0, 1500)}`);
  } finally {
    await browser.close();
    await app.stop();
  }
  console.log(`ui-game-physics: ${passed} passed, 0 failed`);
}

await main();
