/**
 * Code written out in the thread, in a real browser: the agent writes a file
 * with the terminal, and the card for it is there whole at once (no typing, no replay).
 *
 * Needs the app built (npm run build); skips without a browser.
 *
 *   npx tsx tests/ui-code.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { chromium } from "playwright-core";
import { startApp } from "./e2e-harness";
import { CHROME } from "./chrome";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

const LINES = Array.from({ length: 14 }, (_, i) => `const line${i + 1} = ${i + 1};`);

async function main() {
  const exe = CHROME;
  if (!fs.existsSync(exe)) { console.log("  skip  no browser here"); return; }
  if (!fs.existsSync("dist/index.html")) { console.log("  skip  the app is not built (npm run build)"); return; }
  const app = await startApp();
  const browser = await chromium.launch({ executablePath: exe });
  try {
    let step = 0;
    app.decide = (req) => {
      if (/You check one action/.test(req.system)) return { text: '{"destructive": false, "requested": true}' };
      step += 1;
      return step === 1
        ? { tools: [{ name: "terminal", args: { command: `printf '${LINES.join("\\n")}\\n' > app.js` } }] }
        : { text: "Wrote it." };
    };
    const s = await app.newSession("Code", "build");
    await app.turn(s, "write app.js");

    const open = async () => {
      const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
      const page = await ctx.newPage();
      await page.goto(`${app.base}/?session=${s}`);
      // A turn's steps are folded by default (the conversation's contracted activity): open them, as a person would.
      await page.locator(".steps-top").first().click({ timeout: 5000 }).catch(() => undefined);
      return { ctx, page };
    };
    const code = (page: import("playwright-core").Page) => page.locator(".cell.diff .diff-code");

    await test("the whole card is there at once, with no typing and no replay button", async () => {
      const { ctx, page } = await open();
      await page.waitForSelector(".cell.diff .diff-code");
      const text = (await code(page).textContent())!;
      for (const l of LINES) assert.ok(text.includes(l));
      assert.equal(await page.locator(".cell.diff[data-writing]").count(), 0);
      assert.equal(await page.getByRole("button", { name: "Replay this change" }).count(), 0);
      await ctx.close();
    });
  } finally {
    await browser.close();
    await app.stop();
  }
  console.log(`\n${passed} passed`);
  process.exit(0);
}
main().catch((err) => { console.error(err); process.exit(1); });
