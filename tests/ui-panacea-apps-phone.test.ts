/**
 * The app panels on a phone (docs/PANACEA-GAPS.md, G1: "on a phone and a desktop"): the agent places a Music, a 3D, a
 * Game and a Video panel, they fit the 390 px screen, and a finger on each changes the song, the model, the game and
 * the film. One chat and phone for each: the first move opens the app's window and the view goes with it.
 *
 * Needs a build (npm run build, with autora-3d, opencut-editor and gdevelop-editor) and a browser (AUTORA_BROWSER_PATH=/opt/pw-browsers/chromium-1243/chrome-linux64/chrome).
 *
 *   npx tsx tests/ui-panacea-apps-phone.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Page } from "playwright-core";
import starter from "../server/game-starter.json";
import { readGame } from "../src/lib/panacea/apps/game";
import { readModel, type ModelDoc } from "../src/lib/panacea/apps/model";
import { sleep, startApp } from "./e2e-harness";
import { CHROME } from "./chrome";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

async function main() {
  const exe = CHROME;
  const engineFile = path.join("dist", "autora-3d-engine", "engine.mjs");
  if (!exe || !fs.existsSync(exe)) { console.log("  skip  no browser here"); return; }
  if (!fs.existsSync("dist/index.html") || !fs.existsSync(engineFile) || !fs.existsSync("dist/gdevelop-editor/index.html")) { console.log("  skip  the 3D modeller or the game editor is not built (npm run build)"); return; }
  const core = (await import(pathToFileURL(path.resolve(engineFile)).href)) as { Engine: new () => { execute(n: string, a?: unknown): Promise<{ ok: boolean }>; toJSON(): unknown }; initManifold(): Promise<void> };
  await core.initManifold().catch(() => undefined);
  const mine = new core.Engine();
  assert.ok((await mine.execute("shape_add", { kind: "box", x: 0, y: 0, width: 40, depth: 20, height: 10, name: "Base" })).ok);
  const project: any = JSON.parse(JSON.stringify(starter));
  project.layouts[0].objects.push({ name: "Player", type: "Sprite", behaviors: [{ name: "Behavior", type: "PlatformBehavior::PlatformerObjectBehavior", maxSpeed: 250, jumpSpeed: 600, gravity: 1000, deceleration: 1500, acceleration: 1500 }] });

  const app = await startApp();
  const browser = await chromium.launch({ executablePath: exe });
  const errors: string[] = [];
  try {
    await app.api("PATCH", "/api/agent-cursor", { on: false });
    const until = async (what: string, fn: () => Promise<boolean> | boolean, ms = 10_000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) { if (await fn()) return; await sleep(100); }
      throw new Error(`timed out: ${what}`);
    };
    /** One fresh phone and chat per app: the first panel move opens that app's window, and the view goes with it. */
    const onPhone = async (title: string, recipe: string, before: Array<{ name: string; args: Record<string, unknown> }>, setup: (s: string) => Promise<void>, run: (s: string, page: Page, reach: (title: string, control: string) => Promise<{ box: { x: number; y: number; width: number; height: number } }>) => Promise<void>) => {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
      const page: Page = await ctx.newPage();
      page.on("pageerror", (e) => errors.push(e.message));
      const s = await app.newSession(`Phone ${title}`, "build");
      await setup(s);
      await page.goto(`${app.base}/?session=${s}`);
      await page.waitForSelector('textarea[aria-label="Ask Autora"]');
      const steps = [...before, { name: "panacea_place", args: { recipe, why: "to try it by touch" } }];
      let n = 0;
      app.decide = (req) => {
        if (/You check one action/.test(req.system)) return { text: '{"destructive": false, "requested": true}' };
        return n < steps.length ? { tools: [steps[n++]!] } : { text: "Placed." };
      };
      const events = await app.turn(s, `put the ${title} panel up`, 90_000);
      assert.deepEqual(events.filter((e) => e.kind === "tool.error").map((e) => e.payload.error), [], "no tool failed");
      /** Pans the board with a drag on its empty ground until a control sits in the clear part of the screen (above the conversation sheet, below the header). */
      const reach = async (panelTitle: string, control: string) => {
        const panel = page.locator(`.pa-panel[aria-label="${panelTitle}"]`);
        await panel.waitFor();
        assert.ok((await panel.boundingBox())!.width <= 390, `${panelTitle} fits the phone`);
        for (let tries = 0; tries < 6; tries++) {
          const b = (await panel.locator(control).boundingBox())!;
          const y = b.y + b.height / 2;
          if (y > 90 && y < 330 && b.x >= 0 && b.x + b.width <= 390) return { box: b };
          const from = { x: 372, y: 140 };
          await page.mouse.move(from.x, from.y);
          await page.mouse.down();
          await page.mouse.move(from.x, from.y + Math.max(-200, Math.min(200, 200 - y)), { steps: 8 });
          await page.mouse.up();
          await sleep(150);
        }
        throw new Error(`could not bring ${panelTitle} ${control} into the clear part of the screen`);
      };
      try { await run(s, page, reach); } finally { await ctx.close(); }
    };
    const tapMiddle = (page: Page, box: { x: number; y: number; width: number; height: number }, at = 0.5) => page.touchscreen.tap(box.x + box.width * at, box.y + box.height / 2);

    await test("a finger on the Tempo stepper changes the song", () => onPhone("Transport", "music.transport", [], async () => undefined, async (s, page, reach) => {
      const { box } = await reach("Transport", 'button[aria-label="More Tempo"]');
      const before = Number(await page.locator('.pa-panel[aria-label="Transport"] input[aria-label="Tempo"]').inputValue());
      await tapMiddle(page, box);
      await until("the song is a beat faster", async () => ((await app.api("GET", `/api/studio/${s}/doc`)).body as { doc: { bpm: number } }).doc.bpm === before + 1);
    }));

    await test("a finger on the Width slider changes the model", () => onPhone("Size", "3d.size", [], async (s) => {
      assert.equal((await app.api("PUT", `/api/cad/${s}/doc`, { doc: mine.toJSON() })).status, 200);
    }, async (s, page, reach) => {
      const { box } = await reach("Size", '[data-bind="model.width"] .pa-track');
      await tapMiddle(page, box, 0.4);
      await until("the part is about 200 wide", async () => { const d = ((await app.api("GET", `/api/cad/${s}/doc`)).body as { doc: ModelDoc }).doc; return Math.abs((readModel(d, "model.width") as number) - 200) <= 12; });
    }));

    await test("a finger on the Gravity slider changes the game", () => onPhone("Physics", "game.physics", [], async (s) => {
      assert.equal((await app.api("PUT", `/api/game/${s}/project`, { project })).status, 200);
    }, async (s, page, reach) => {
      const { box } = await reach("Physics", '[data-bind="game.gravity"] .pa-track');
      await tapMiddle(page, box);
      await until("the player's gravity is about 1500", async () => { const g = ((await app.api("GET", `/api/game/${s}/project`)).body as { project: unknown }).project; return Math.abs((readGame(g, "game.gravity") as number) - 1500) <= 60; });
    }));

    if (fs.existsSync("dist/opencut-editor/index.html")) {
      await test("a finger on the Aspect control changes the film", () => onPhone("Project", "video.project", [{ name: "video_open", args: { new: "Phone cut" } }], async () => undefined, async (s, page, reach) => {
        await reach("Project", '[data-bind="video.aspect"]');
        await page.locator('.pa-panel[aria-label="Project"]').getByRole("radio", { name: "9:16", exact: true }).tap();
        await until("the canvas is 1080x1920", async () => { const p = ((await app.api("GET", `/api/opencut/${s}/project`)).body as { state: { canvas: { width: number; height: number } } | null }).state; return p?.canvas.width === 1080 && p.canvas.height === 1920; }, 30_000);
      }));
    }
    assert.deepEqual(errors, [], "no page errors");
  } finally { await browser.close(); await app.stop(); }
  console.log(`\n${passed} ui-panacea-apps-phone tests passed`);
}
main().catch((e) => { console.error(e); process.exit(1); });
