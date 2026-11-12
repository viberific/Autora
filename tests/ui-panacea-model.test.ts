/**
 * Panacea's 3D panels in a real browser (docs/PANACEA-GAPS.md, G1): the Width slider on a Size panel changes the model
 * in Autora 3D; a change made to the model elsewhere shows on the panel; and the Part list picks the part a Material
 * panel's colour and finish go to.
 *
 * Needs a build (npm run build, with autora-3d) and a browser (AUTORA_BROWSER_PATH=/opt/pw-browsers/chromium-1243/chrome-linux64/chrome).
 *
 *   npx tsx tests/ui-panacea-model.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Page } from "playwright-core";
import { modelParts, readModel, type ModelDoc } from "../src/lib/panacea/apps/model";
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
  if (!fs.existsSync("dist/index.html") || !fs.existsSync(engineFile)) { console.log("  skip  no build (npm run build, with autora-3d)"); return; }
  // The test makes the model with the modeller's own engine, as the person's window would hand it over.
  const core = (await import(pathToFileURL(path.resolve(engineFile)).href)) as { Engine: new () => { execute(n: string, a?: unknown): Promise<{ ok: boolean }>; toJSON(): unknown; getDoc(): ModelDoc }; initManifold(): Promise<void> };
  await core.initManifold().catch(() => undefined);
  const mine = new core.Engine();
  for (const a of [{ kind: "box", x: 0, y: 0, width: 40, depth: 20, height: 10, name: "Base" }, { kind: "cylinder", x: 100, y: 50, width: 30, depth: 30, height: 25, name: "Post" }]) assert.ok((await mine.execute("shape_add", a)).ok);

  const app = await startApp();
  const browser = await chromium.launch({ executablePath: exe });
  const page: Page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await app.api("PATCH", "/api/agent-cursor", { on: false });
    const s = await app.newSession("3D panels", "build");
    const doc = async () => ((await app.api("GET", `/api/cad/${s}/doc`)).body as { doc: ModelDoc }).doc;
    const until = async (what: string, fn: () => Promise<boolean> | boolean, ms = 8000) => {
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

    // Panels first, on the empty board; then the person's model arrives and the 3D window with it.
    await place("3d.size", "size", "Size", 60, 80);
    await place("3d.material", "material", "Material", 460, 80);
    assert.equal((await app.api("POST", `/api/cad/${s}/open`)).status, 200);
    assert.equal((await app.api("PUT", `/api/cad/${s}/doc`, { doc: mine.toJSON() })).status, 200);

    await test("the Width slider changes the model in Autora 3D", async () => {
      /* The 3D window has just arrived, far from the panels: Autora's own framing shows the newest piece at a size that can
         be read rather than everything too small to use, so the person asks for all of it. */
      await page.getByRole("button", { name: "Show all work", exact: true }).click();
      await sleep(400);
      const size = page.locator('.pa-panel[aria-label="Size"]');
      const width = size.locator('[data-bind="model.width"]');
      await until("the panel shows the model's width", async () => (await width.locator(".pa-track").getAttribute("aria-valuenow")) === "40");
      const box = (await width.locator(".pa-track").boundingBox())!;
      await page.mouse.click(box.x + box.width * 0.2, box.y + box.height / 2);
      await until("the model's first part is about 100 wide", async () => { const w = readModel(await doc(), "model.width") as number; return Math.abs(w - 100) <= 8; });
    });

    await test("a change made to the model elsewhere shows on the panel", async () => {
      const first = modelParts(mine.getDoc())[0]!;
      assert.ok((await mine.execute("shape_resize", { id: first.id, width: 150 })).ok);
      assert.equal((await app.api("PUT", `/api/cad/${s}/doc`, { doc: mine.toJSON() })).status, 200);
      await until("the panel shows 150", async () => (await page.locator('.pa-panel[aria-label="Size"] [data-bind="model.width"] .pa-track').getAttribute("aria-valuenow")) === "150");
    });

    await test("the Part list picks the part a Material panel's finish goes to", async () => {
      const panel = page.locator('.pa-panel[aria-label="Material"]');
      await panel.locator('[data-bind="model.part"] .pa-select-btn').click();
      await panel.getByRole("option", { name: "Post", exact: true }).click();
      await panel.getByRole("radio", { name: "metal", exact: true }).click();
      const [base, post] = modelParts(await doc());
      await until("the Post is metal", async () => { const d = await doc(); return readModel(d, "model.material", post!.id) === "metal"; });
      assert.notEqual(readModel(await doc(), "model.material", base!.id), "metal", "the other part is untouched");
    });
    assert.deepEqual(errors, [], "no page errors");
  } finally { await browser.close(); await app.stop(); }
  console.log(`\n${passed} ui-panacea-model tests passed`);
}
main().catch((e) => { console.error(e); process.exit(1); });
