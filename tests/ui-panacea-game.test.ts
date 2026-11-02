/**
 * Panacea's Game panels in a real browser (docs/PANACEA-GAPS.md, G1): the Gravity slider on a Physics panel changes the
 * game's movement behaviour in Autora Games, a change made to the game elsewhere shows on the panel, and the Object list
 * picks which object a Movement panel's speed goes to.
 *
 * Needs a build (npm run build, with gdevelop-editor) and a browser (AUTORA_BROWSER_PATH=/opt/pw-browsers/chromium-1243/chrome-linux64/chrome).
 *
 *   npx tsx tests/ui-panacea-game.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { chromium, type Page } from "playwright-core";
import starter from "../server/game-starter.json";
import { readGame } from "../src/lib/panacea/apps/game";
import { sleep, startApp } from "./e2e-harness";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

const platformer = () => ({ name: "Behavior", type: "PlatformBehavior::PlatformerObjectBehavior", maxSpeed: 250, jumpSpeed: 600, gravity: 1000, deceleration: 1500, acceleration: 1500 });
const topDown = () => ({ name: "Behavior", type: "TopDownMovementBehavior::TopDownMovementBehavior", maxSpeed: 200, deceleration: 800, acceleration: 400 });

async function main() {
  const exe = process.env.AUTORA_BROWSER_PATH || ["/opt/pw-browsers/chromium-1243/chrome-linux64/chrome", "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", "/opt/pw-browsers/chromium"].find((p) => fs.existsSync(p));
  if (!exe || !fs.existsSync(exe)) { console.log("  skip  no browser here"); return; }
  if (!fs.existsSync("dist/index.html") || !fs.existsSync("dist/gdevelop-editor/index.html")) { console.log("  skip  the game editor is not built (npm run build, with gdevelop-editor)"); return; }
  const project: any = JSON.parse(JSON.stringify(starter));
  project.layouts[0].objects.push({ name: "Player", type: "Sprite", behaviors: [platformer()] });
  project.objects.push({ name: "Ghost", type: "Sprite", behaviors: [topDown()] });

  const app = await startApp();
  const browser = await chromium.launch({ executablePath: exe });
  const page: Page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await app.api("PATCH", "/api/agent-cursor", { on: false });
    const s = await app.newSession("Game panels", "build");
    const game = async () => ((await app.api("GET", `/api/game/${s}/project`)).body as { project: unknown }).project;
    const until = async (what: string, fn: () => Promise<boolean> | boolean, ms = 10_000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) { if (await fn()) return; await sleep(100); }
      throw new Error(`timed out: ${what}`);
    };
    await page.goto(`${app.base}/?session=${s}`);
    await page.waitForSelector('textarea[aria-label="Ask Autora"]');
    const place = async (recipe: string, word: string, title: string, x: number, y: number) => {
      const box = (await page.locator(".pa-board").boundingBox())!;
      await page.mouse.dblclick(box.x + x, box.y + y);
      await page.waitForSelector(".pa-summon-q");
      await page.fill(".pa-summon-q", word);
      await page.click(`.pa-summon [data-recipe="${recipe}"]`);
      await page.waitForSelector(`.pa-panel[aria-label="${title}"]`, { timeout: 5000 });
    };
    // Panels first, on the empty board; then the person's game arrives and the Game window with it.
    await place("game.physics", "physics", "Physics", 40, 60);
    await place("game.movement", "movement", "Movement", 400, 60);
    assert.equal((await app.api("POST", `/api/game/${s}/open`)).status, 200);
    assert.equal((await app.api("PUT", `/api/game/${s}/project`, { project })).status, 200);

    await test("the Gravity slider changes the game's behaviour", async () => {
      const gravity = page.locator('.pa-panel[aria-label="Physics"] [data-bind="game.gravity"] .pa-track');
      await until("the panel shows the game's gravity", async () => (await gravity.getAttribute("aria-valuenow")) === "1000");
      const box = (await gravity.boundingBox())!;
      await page.mouse.click(box.x + box.width * 0.5, box.y + box.height / 2);
      await until("the player's gravity is about 1500", async () => { const g = readGame(await game(), "game.gravity", "Player") as number; return Math.abs(g - 1500) <= 60; });
      assert.equal(readGame(await game(), "game.speed", "Ghost"), 200, "the other object is untouched");
    });

    await test("a change made to the game elsewhere shows on the panel", async () => {
      const next: any = await game();
      next.layouts[0].objects.find((o: any) => o.name === "Player").behaviors[0].gravity = 2400;
      assert.equal((await app.api("PUT", `/api/game/${s}/project`, { project: next })).status, 200);
      await until("the panel shows 2400", async () => (await page.locator('.pa-panel[aria-label="Physics"] [data-bind="game.gravity"] .pa-track').getAttribute("aria-valuenow")) === "2400");
    });

    await test("the Object list picks which object the speed goes to", async () => {
      const panel = page.locator('.pa-panel[aria-label="Movement"]');
      await panel.locator('[data-bind="game.object"] .pa-select-btn').click();
      await panel.getByRole("option", { name: "Ghost", exact: true }).click();
      const run = panel.locator('[data-bind="game.speed"] .pa-track');
      await until("the panel shows the Ghost's speed", async () => (await run.getAttribute("aria-valuenow")) === "200");
      const box = (await run.boundingBox())!;
      await page.mouse.click(box.x + box.width * 0.5, box.y + box.height / 2);
      await until("the Ghost is about 500", async () => { const v = readGame(await game(), "game.speed", "Ghost") as number; return Math.abs(v - 500) <= 30; });
      assert.equal(readGame(await game(), "game.speed", "Player"), 250, "the Player is untouched");
    });
    assert.deepEqual(errors, [], "no page errors");
  } finally { await browser.close(); await app.stop(); }
  console.log(`\n${passed} ui-panacea-game tests passed`);
}
main().catch((e) => { console.error(e); process.exit(1); });
