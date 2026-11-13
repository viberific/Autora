/**
 * The board's right-click menu (src/components/panacea/BoardMenu.tsx), in a real browser: a right-click on the empty board
 * gives New, Open file and Add piece (View only once there is work to move around); New opens a blank file in its window,
 * or a native piece where the click was; Add piece opens the picker there; the keys and Escape work it.
 *
 * Needs a build (npm run build); New Spreadsheet needs the Office editors (node scripts/build-office.mjs) and is skipped
 * without them.
 *
 *   npx tsx tests/ui-board-menu.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { chromium, type Page } from "playwright-core";
import { sleep, startApp } from "./e2e-harness";
import { CHROME } from "./chrome";
import { shrinkConversation, workspaceReady } from "./ui-workspace-ready";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

async function main() {
  if (!fs.existsSync(CHROME)) { console.log("  skip  no browser here"); return; }
  if (!fs.existsSync("dist/index.html")) { console.log("  skip  the app is not built (npm run build)"); return; }
  const app = await startApp();
  const browser = await chromium.launch({ executablePath: CHROME });
  try {
    await app.api("PATCH", "/api/agent-cursor", { on: false });
    const s = await app.newSession("Board menu", "build");
    const page: Page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${app.base}/?session=${s}`);
    await page.waitForSelector('textarea[aria-label="Ask Autora"]');
    assert.equal((await app.api("POST", `/api/panacea/${s}/open`)).status, 200);
    await page.waitForSelector(".pa-board");
    await workspaceReady(page, { blank: true });
    await shrinkConversation(page);
    const area = (await page.locator(".pa-board").boundingBox())!;
    const spot = { x: area.x + area.width - 420, y: area.y + 120 };
    const menu = page.getByRole("menu", { name: "Board", exact: true });
    const top = () => menu.getByRole("menuitem").allInnerTexts();
    /** A point on the board with nothing over it: no work, no chrome, no conversation. */
    const emptySpot = async () => (await page.evaluate(() => {
      const r = document.querySelector(".pa-board")!.getBoundingClientRect();
      for (let y = r.top + 60; y < r.bottom - 60; y += 40) for (let x = r.left + 60; x < r.right - 60; x += 40) {
        const el = document.elementFromPoint(x, y) as HTMLElement | null;
        if (el && el.closest(".pa-board") && !el.closest(".pa-panel, .pa-surface, .pa-summon, .pa-chrome, .pw-engine, .conversation-flow")) return { x, y };
      }
      return null;
    }))!;
    const until = async (what: string, fn: () => Promise<boolean>, ms = 15_000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) { if (await fn().catch(() => false)) return; await sleep(150); }
      throw new Error(`timed out: ${what}`);
    };

    await test("a right-click on the empty board gives New, Open file and Add piece; no View with nothing to look at", async () => {
      await page.mouse.click(spot.x, spot.y, { button: "right" });
      await menu.waitFor();
      assert.deepEqual((await top()).map((t) => t.replace("›", "").trim()), ["New", "Open file…", "Add piece…"]);
      const box = (await menu.boundingBox())!;
      assert.ok(Math.abs(box.x - spot.x) < 12 && Math.abs(box.y - spot.y) < 12, "at the pointer");
    });

    await test("New opens beside it to the files and the native pieces; the keys work it and Escape puts it away", async () => {
      assert.equal(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.textContent?.replace("›", "").trim()), "New");
      await page.keyboard.press("ArrowRight");
      const sub = page.getByRole("menu", { name: "New", exact: true });
      await sub.waitFor();
      const items = (await sub.getByRole("menuitem").allInnerTexts()).map((t) => t.trim());
      assert.deepEqual(items, ["Document", "Spreadsheet", "Slides", "PDF", "Board", "Flowchart", "Project"]);
      const [m, n] = [(await menu.boundingBox())!, (await sub.boundingBox())!];
      assert.ok(n.x >= m.x + m.width - 2 || n.x + n.width <= m.x + 2, "beside the list, not over it");
      await until("the first entry focused", async () => (await page.evaluate(() => document.activeElement?.textContent?.trim())) === "Document", 2000);
      await page.keyboard.press("ArrowLeft");
      assert.equal(await sub.count(), 0, "left closes the group");
      await page.keyboard.press("Escape");
      assert.equal(await menu.count(), 0);
    });

    await test("New, Board puts a board where the right-click was", async () => {
      await page.mouse.click(spot.x, spot.y, { button: "right" });
      await menu.getByRole("menuitem", { name: /New/ }).hover();
      await page.getByRole("menu", { name: "New", exact: true }).getByRole("menuitem", { name: "Board", exact: true }).click();
      await page.waitForSelector(".pa-surface.is-board");
      assert.equal(await menu.count(), 0, "the menu goes");
    });

    await test("Add piece opens the picker there; with work on the board, View appears and Show all frames it", async () => {
      await page.keyboard.press("Escape");
      const empty = await emptySpot();
      await page.mouse.click(empty.x, empty.y, { button: "right" });
      await menu.waitFor();
      const names = (await top()).map((t) => t.replace("›", "").trim());
      assert.ok(names.includes("View"), names.join(", "));
      await menu.getByRole("menuitem", { name: "Add piece…" }).click();
      await page.waitForSelector(".pa-summon");
      await page.keyboard.press("Escape");
      await page.mouse.click(empty.x, empty.y, { button: "right" });
      await menu.getByRole("menuitem", { name: /View/ }).hover();
      await page.getByRole("menu", { name: "View", exact: true }).getByRole("menuitem", { name: "Show all work" }).click();
      assert.equal(await menu.count(), 0);
    });

    await test("a right-click on a piece of work is not the board's", async () => {
      const surface = (await page.locator(".pa-surface.is-board").boundingBox())!;
      await page.mouse.click(surface.x + surface.width / 2, surface.y + surface.height / 2, { button: "right" });
      await sleep(200);
      assert.equal(await menu.count(), 0);
      await page.keyboard.press("Escape");
    });

    if (fs.existsSync("dist/office/web/sheets/index.html")) {
      await test("New, Spreadsheet opens a blank workbook in the Sheets window, with no turn", async () => {
        const turns = app.seen.length;
        const empty = await emptySpot();
        await page.mouse.click(empty.x, empty.y, { button: "right" });
        await menu.getByRole("menuitem", { name: /New/ }).hover();
        await page.getByRole("menu", { name: "New", exact: true }).getByRole("menuitem", { name: "Spreadsheet", exact: true }).click();
        await until("the Sheets window", async () => (await page.locator('.pw-engine[data-work="engine:sheets"]').count()) === 1, 40_000);
        assert.equal(app.seen.length, turns, "nothing was asked of the model");
      });
    } else console.log("  skip  New, Spreadsheet: the Office editors are not built");

    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await app.stop();
  }
  console.log(`\n${passed} passed`);
}

main().catch((err) => { console.error(err); process.exit(1); });
