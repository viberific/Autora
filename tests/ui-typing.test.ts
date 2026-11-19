/**
 * Typing with nothing focused goes to the message box, and the bare k and v are not shortcuts (docs/TRY-IT-2026-11-19-GAME.md,
 * F4): a newcomer who clicked the empty canvas and typed "make me a game" was taken to the Mind page at the k.
 *
 *   npx tsx tests/ui-typing.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { chromium } from "playwright-core";
import { sleep, startApp } from "./e2e-harness";
import { CHROME } from "./chrome";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

async function main() {
  if (!CHROME || !fs.existsSync(CHROME)) { console.log("  skip  no browser here"); return; }
  if (!fs.existsSync("dist/index.html")) { console.log("  skip  no build (npm run build)"); return; }
  const app = await startApp();
  const browser = await chromium.launch({ executablePath: CHROME });
  try {
    const s = await app.newSession("Typing", "build");
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
    await page.goto(`${app.base}/?session=${s}`);
    await page.waitForSelector('textarea[aria-label="Ask Autora"]');
    const box = () => page.locator('textarea[aria-label="Ask Autora"]');
    const where = () => new URL(page.url()).searchParams.get("page") ?? "chat";

    await test("typing on the empty canvas goes into the message box, whatever the letters are", async () => {
      await page.mouse.click(700, 300);
      await page.keyboard.type("make me a game", { delay: 15 });
      assert.equal(await box().inputValue(), "make me a game");
      assert.equal(where(), "chat", "the k did not take them to the Mind page");
    });

    await test("the shortcuts for Mind and voice need Alt, so a letter is never one", async () => {
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.keyboard.press("Alt+k");
      await sleep(300);
      assert.equal(where(), "mind", "Alt+K opens Mind");
      await page.keyboard.press("Alt+k");
      await sleep(300);
      assert.equal(where(), "chat", "and Alt+K again comes back");
    });

    await test("a key with Ctrl or Cmd held is left to the browser, and Escape still lets go of a field", async () => {
      await box().click();
      await page.keyboard.press("Escape");
      assert.notEqual(await page.evaluate(() => document.activeElement?.tagName), "TEXTAREA");
      await page.keyboard.press("Control+a");
      assert.equal(where(), "chat");
    });

    await test("with no model connected the message box offers a way to connect one, and it goes to Settings", async () => {
      // A fresh chat with nothing connected (usability trial F1: "Connect a model to start…" was only a placeholder).
      await app.api("PATCH", "/api/settings", { provider: "openai", models: { openai: "gpt-4o-mini" } });
      const s2 = await app.newSession("No model", "build");
      await page.goto(`${app.base}/?session=${s2}`);
      await page.waitForSelector('textarea[aria-label="Ask Autora"]');
      const connect = page.getByRole("button", { name: "Connect a model" });
      await connect.waitFor({ timeout: 10_000 });
      await connect.click();
      await sleep(500);
      assert.equal(where(), "config", "the button opens Settings");
    });
  } finally {
    await browser.close();
    await app.stop();
  }
  console.log(`${passed} ui-typing tests passed`);
}

main().catch((err) => { console.error(err); process.exit(1); });
