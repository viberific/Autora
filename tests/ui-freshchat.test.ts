/**
 * The "new chat for this" card as a person sees it, in a real browser: a long chat sent a new task shows the card with
 * what the chat now sends on every step; pressing its button opens a new chat that starts with that message.
 *
 *   npx tsx tests/ui-freshchat.test.ts          (FRESH_SHOTS=<dir> keeps screenshots)
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
  const exe = process.env.AUTORA_BROWSER_PATH || ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome", "/opt/pw-browsers/chromium"].find((p) => fs.existsSync(p));
  if (!exe || !fs.existsSync(exe)) { console.log("  skip  no browser here"); return; }
  if (!fs.existsSync("dist/index.html")) { console.log("  skip  no build (npm run build)"); return; }
  const shots = process.env.FRESH_SHOTS || "";
  const app = await startApp();
  const browser = await chromium.launch({ executablePath: exe });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    const s = await app.newSession("Invoices", "build");
    app.script = [{ text: "Fixed.", promptTokens: 40_000 }];
    await app.turn(s, "Fix the invoice export so totals include tax");
    app.script = [{ text: "Fixed.", promptTokens: 110_000 }];
    await app.turn(s, "The invoice PDF still shows the old total, fix the tax line");
    app.script = [{ text: "On it.", promptTokens: 112_000 }];
    await app.turn(s, "Set up a nightly backup of the photos folder to the NAS");
    await page.goto(`${app.base}/?session=${s}`);

    await test("the card says this looks like a new task and what the chat now sends on every step", async () => {
      await page.waitForSelector(".fresh-cell");
      const text = await page.locator(".fresh-cell").innerText();
      assert.match(text, /This looks like a new task/);
      assert.match(text, /about 110k tokens on every step \(it began at 40k\)/);
      await page.locator(".fresh-cell").scrollIntoViewIfNeeded();
      await sleep(400);
      if (shots) await page.screenshot({ path: `${shots}/fresh-card.png` });
    });

    await test("Start a new chat for this opens a chat that begins with the message", async () => {
      app.script = [{ text: "Setting up the backup." }];
      await page.click(".fresh-acts button.is-accent");
      await page.waitForFunction((was) => !location.search.includes(was), s, { timeout: 8000 });
      await page.waitForSelector("text=Set up a nightly backup of the photos folder to the NAS");
      await sleep(300);
      if (shots) await page.screenshot({ path: `${shots}/fresh-moved.png` });
      assert.deepEqual(errors, []);
    });
  } finally {
    await browser.close();
    await app.stop();
  }
  console.log(`\n${passed} passed`);
}

main().then(() => process.exit(0), (err) => { console.error(err); process.exit(1); });
