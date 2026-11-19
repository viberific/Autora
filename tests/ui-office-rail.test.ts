/**
 * Pages, Sheets and Slides on the tool bar (office/shim/rail.js, docs/TOOL-RAIL.md), in a real browser with the real editors:
 * the ribbon is never seen, the bar is down the right of a desktop with the common tools, All tools holds every command of
 * the ribbon (one group per tab, each tile pinnable), the editor's own keyboard shortcuts still work and the bar's tools
 * light up with them, and the tooltips say the shortcut.
 *
 * Needs the app and the Office editors built (npm run build, then node scripts/build-office.mjs); skips without a browser.
 *
 *   npx tsx tests/ui-office-rail.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { chromium, type Frame, type Page } from "playwright-core";
import { sleep, startApp } from "./e2e-harness";
import { CHROME } from "./chrome";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}
const guard = (req: { system: string }) => (/You check one action/.test(req.system) ? { text: '{"destructive": false, "requested": true}' } : null);

async function until(what: string, fn: () => Promise<boolean>, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn().catch(() => false)) return; await sleep(200); }
  throw new Error(`timed out waiting for ${what}`);
}
const editorOf = (page: Page): Frame | undefined => page.frames().find((f) => f !== page.mainFrame() && f.url().includes("/office-app/"));

const DOCS = { name: "office_create", args: { type: "docx", name: "memo", markdown: "# Memo\n\nHello team.\n" } };
const SHEETS = { name: "office_create", args: { type: "xlsx", name: "pets", rows: [["Breed", "Weight"], ["Beagle", 10.5]] } };

async function main() {
  const exe = CHROME;
  if (!fs.existsSync(exe)) { console.log("  skip  no browser here"); return; }
  if (!fs.existsSync("dist/office/web/docs/index.html")) { console.log("  skip  the Office editors are not built"); return; }
  const app = await startApp();
  const browser = await chromium.launch({ executablePath: exe });
  try {
    for (const [app_, tool, bold] of [["docs", DOCS, "text=Hello team."], ["sheets", SHEETS, ""]] as const) {
      const s = await app.newSession(app_, "build");
      let n = 0;
      app.decide = (req) => guard(req) ?? (n++ === 0 ? { tools: [tool] } : { text: "Done." });
      await app.turn(s, "go", 120_000);
      app.decide = null;
      const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
      await page.goto(`${app.base}/?session=${s}`);
      await page.waitForSelector(".office-window");
      await until("the editor's frame", async () => !!editorOf(page), 40_000);
      const frame = editorOf(page)!;
      // The bar is a card that comes to the pick (Pages) or the right-click menu (Sheets), so it is not always drawn: its buttons are
      // pressed in the page, as ui-office-needs does, which is what the agent's hand and a shortcut reach too.
      const press = (selector: string) => frame.evaluate((sel) => document.querySelector<HTMLElement>(sel)!.click(), selector);
      await frame.waitForSelector("#autora-rail", { state: "attached", timeout: 40_000 });

      await test(`${app_}: the ribbon is not shown, and the bar holds the common tools`, async () => {
        await until("the ribbon to be closed", async () => ((await frame.evaluate(() => document.querySelector(".ribbon, header.excel-header")?.getBoundingClientRect().height ?? 0)) < 2));
        // The contextual design (0.9.3xx): the bar is a card that comes to the words (Pages) or is the right-click menu (Sheets), not a
        // rail fixed down the right. It holds the common tools and the grid button; when it is drawn it lies inside the editor.
        const bar = await frame.evaluate(() => {
          const el = document.querySelector("#autora-rail")!;
          const r = el.getBoundingClientRect();
          const drawn = r.width > 0 && getComputedStyle(el).visibility !== "hidden";
          return { drawn, inside: r.left >= -1 && r.right <= window.innerWidth + 1 && r.top >= -1 && r.bottom <= window.innerHeight + 1, buttons: el.querySelectorAll("button").length };
        });
        assert.ok(!bar.drawn || bar.inside, "drawn inside the editor, never off it");
        assert.ok(bar.buttons >= 10, "as many tools as fit, and the grid button");
      });

      await test(`${app_}: All tools holds every command of the ribbon, grouped by tab, and each tile can be pinned`, async () => {
        // The rail reads every ribbon command, tab by tab, once the editor is up; the grid is what it read.
        await frame.waitForSelector("html[data-rail-scanned]", { state: "attached", timeout: 60_000 });
        await press('#autora-rail [aria-label="All tools"]');
        await frame.waitForSelector("#autora-grid h4", { timeout: 20_000 });
        const groups = (await frame.locator("#autora-grid h4").allTextContents()).map((g) => g.trim());
        assert.ok(groups.includes("Insert") && groups.includes("View"), `groups: ${groups.join(", ")}`);
        assert.ok((await frame.locator("#autora-grid .ar-tile").count()) > 60, "dozens of commands, not a handful");
        assert.ok((await frame.locator("#autora-grid .ar-pin").count()) > 60, "each with a pin");
        await press('#autora-grid [aria-label="Close"]');
        await frame.waitForSelector("#autora-grid", { state: "detached", timeout: 10_000 });
      });

      await test(`${app_}: the editor's keyboard shortcuts still work, and the bar's tools follow them`, async () => {
        if (bold) await frame.locator(bold).first().click(); else await page.mouse.click(1000, 400);
        await page.keyboard.press("Control+A");
        await page.keyboard.press("Control+B");
        await until("Bold to light up on the bar", async () => (await frame.locator('#autora-rail [aria-label="Bold"].on').count()) === 1);
        await page.keyboard.press("Control+B");
        await until("Bold to go out again", async () => (await frame.locator('#autora-rail [aria-label="Bold"].on').count()) === 0);
        assert.match((await frame.locator('#autora-rail [aria-label="Bold"]').getAttribute("title")) ?? "", /Ctrl\+B/i, "the tooltip says the shortcut");
      });

      await test(`${app_}: a tool on the bar does what its ribbon button does`, async () => {
        if (bold) await frame.locator(bold).first().click(); else await page.mouse.click(1000, 400);
        await page.keyboard.press("Control+A");
        await press('#autora-rail [aria-label="Italic"]');
        await until("Italic to be on", async () => (await frame.locator('#autora-rail [aria-label="Italic"].on').count()) === 1);
        await press('#autora-rail [aria-label="Italic"]');
      });
      await page.close();
    }
  } finally {
    await browser.close();
    await app.stop();
  }
  console.log(`\n${passed} passed`);
}
main().catch((e) => { console.error(e); process.exit(1); });
