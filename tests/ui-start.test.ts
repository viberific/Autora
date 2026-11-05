/**
 * Starting work in a real browser, as a person on a desk would (docs/TRY-IT-2026-11-05.md and the follow-up pass):
 * Enter sends and Shift+Enter writes a line, the Capabilities chooser says plainly which editors this server does not have,
 * and a blank screen carries no Follow switch, context meter or canvas bar.
 *
 *   npx tsx tests/ui-start.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { chromium } from "playwright-core";
import { sleep, startApp } from "./e2e-harness";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

async function main() {
  const exe = process.env.AUTORA_BROWSER_PATH || ["/opt/pw-browsers/chromium-1243/chrome-linux64/chrome", "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", "/opt/pw-browsers/chromium"].find((p) => fs.existsSync(p));
  if (!exe || !fs.existsSync(exe)) { console.log("  skip  no browser here"); return; }
  if (!fs.existsSync("dist/index.html")) { console.log("  skip  the page is not built (npm run build)"); return; }
  const app = await startApp();
  const browser = await chromium.launch({ executablePath: exe });
  try {
    const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    await page.goto(app.base);
    const box = page.locator('textarea[aria-label="Ask Autora"]');
    await box.waitFor();

    await test("a blank screen has no Follow switch, no context meter and no canvas bar in sight", async () => {
      assert.equal(await page.locator("button.stage-follow", { hasText: "Follow" }).count(), 0);
      assert.equal(await page.locator(".rail-ctxbar").count(), 0);
      assert.equal(await page.locator(".pa-canvas-bar:not([data-idle])").count(), 0);
    });

    await test("Shift+Enter writes a line and Enter sends it", async () => {
      app.decide = () => ({ text: "Got it." });
      await box.fill("line one");
      await box.press("Shift+Enter");
      await page.keyboard.type("line two");
      assert.equal(await box.inputValue(), "line one\nline two");
      await box.press("Enter");
      await page.waitForFunction(() => document.body.innerText.includes("Got it."), null, { timeout: 15_000 });
      assert.equal(await box.inputValue(), "");
      assert.match(await page.innerText("body"), /\byou\b/i, "the message is labelled You");
    });

    await test("the chooser shows every capability at once, and a missing editor is called missing", async () => {
      await page.locator('button[aria-label="Panacea capabilities"]').first().click();
      await page.waitForSelector(".tool-tiles");
      const installed = ((await app.api("GET", "/api/settings")).body.tools.installed ?? {}) as Record<string, boolean>;
      assert.equal(typeof installed.pdf, "boolean");
      const tiles = await page.locator(".tool-tile").evaluateAll((els) => els.map((e) => ({ name: e.querySelector("b")?.textContent ?? "", text: (e as HTMLElement).innerText, off: (e as HTMLButtonElement).disabled })));
      assert.ok(tiles.length >= 12);
      const body = page.locator(".tools-body");
      const fits = await body.evaluate((e) => e.scrollHeight <= e.clientHeight + 40);
      assert.ok(fits, "the list does not hide capabilities below a scroll");
      const sheets = tiles.find((t) => t.name === "Spreadsheets")!;
      if (installed.sheets === false) {
        assert.ok(sheets.off);
        assert.match(sheets.text, /Not installed on this server/);
      } else assert.ok(!sheets.off);
      await page.keyboard.press("Escape");
      await sleep(200);
    });
  } finally {
    await browser.close();
    await app.stop();
  }
  console.log(`\n${passed} passed, 0 failed`);
}
main().catch((e) => { console.error(e); process.exit(1); });
