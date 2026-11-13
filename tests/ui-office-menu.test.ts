/**
 * Sheets' right-click menu (M1, M2; office/shim/rail.js, office/patches/0004): in the real editor, a right-click in a cell
 * gives Autora's one short vertical list -- Formatting, Data, Formula, Autora -- and not the grid's own long menu.
 * Formatting opens beside it to Bold, Italic, Underline, Text colour and Cell colour; above the groups, a row of pinned
 * icons the person sets with each entry's pin; a plain click in a cell brings up nothing; an entry does what the editor's own
 * command does; only entries that apply to the pick are there; Escape, a click elsewhere or a wheel puts it away.
 *
 * Needs the app and the Office editors built (npm run build, then node scripts/build-office.mjs); skips without them.
 *
 *   npx tsx tests/ui-office-menu.test.ts
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
const SHEETS = { name: "office_create", args: { type: "xlsx", name: "pets", rows: [["Breed", "Weight"], ["Beagle", 10.5], ["Collie", 22]] } };

async function main() {
  if (!fs.existsSync(CHROME)) { console.log("  skip  no browser here"); return; }
  if (!fs.existsSync("dist/office/web/sheets/index.html")) { console.log("  skip  the Office editors are not built"); return; }
  const app = await startApp();
  const browser = await chromium.launch({ executablePath: CHROME });
  try {
    const s = await app.newSession("sheets", "build");
    let n = 0;
    app.decide = (req) => guard(req) ?? (n++ === 0 ? { tools: [SHEETS] } : { text: "Done." });
    await app.turn(s, "go", 120_000);
    app.decide = null;
    const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    await page.goto(`${app.base}/?session=${s}`);
    await page.waitForSelector(".office-window");
    await until("the editor's frame", async () => !!editorOf(page), 40_000);
    const frame = editorOf(page)!;
    await frame.waitForSelector("#autora-rail", { state: "attached", timeout: 40_000 });
    await until("the editor to read its ribbon", async () => (await frame.evaluate(() => document.documentElement.getAttribute("data-rail-scanned"))) === "1", 60_000);
    // A cell of the grid, on the page: the frame's grid, a little in from its top-left.
    const grid = await frame.evaluate(() => { const r = document.querySelector("#univer-container")!.getBoundingClientRect(); return { x: r.left, y: r.top }; });
    const frameBox = (await (await frame.frameElement()).boundingBox())!;
    const cell = { x: frameBox.x + grid.x + 160, y: frameBox.y + grid.y + 110 };
    const menuOpen = () => frame.evaluate(() => !!document.querySelector("#autora-menu"));
    const groups = () => frame.locator("#autora-menu .am-list:not(.am-sub) > button").allTextContents();
    const rightClick = async () => {
      await page.mouse.click(cell.x, cell.y, { button: "right" });
      await until("the menu", menuOpen, 5_000);
    };

    await test("a click in a cell brings nothing up: no tool card pops up on a pick", async () => {
      await page.mouse.click(cell.x, cell.y);
      await sleep(400);
      await page.keyboard.press("Shift+ArrowDown");
      await sleep(300);
      assert.notEqual(await frame.evaluate(() => document.getElementById("autora-rail")?.getAttribute("data-open")), "1", "the card stays away");
      assert.equal(await menuOpen(), false);
      await page.mouse.click(cell.x, cell.y);
    });

    await test("a right-click in a cell gives one short vertical list of groups, not the grid's own menu", async () => {
      await rightClick();
      const names = (await groups()).map((g) => g.replace("›", "").trim());
      assert.deepEqual(names, ["Formatting", "Data", "Formula", "Autora"]);
      const shape = await frame.evaluate(() => {
        const list = document.querySelector("#autora-menu .am-list")!.getBoundingClientRect();
        const rows = [...document.querySelectorAll("#autora-menu .am-list:not(.am-sub) > button")].map((b) => b.getBoundingClientRect());
        return { tall: list.height > list.width, stacked: rows.every((r, i) => i === 0 || r.top > rows[i - 1].top), univer: document.querySelectorAll("[data-u-context-menu-submenu], .univer-menu-root, [class*='univer-context-menu']").length };
      });
      assert.ok(shape.stacked, "the groups are one under the other");
      assert.equal(shape.univer, 0, "the grid's own menu is not shown");
      assert.equal(await frame.evaluate(() => document.getElementById("autora-rail")?.getAttribute("data-open")), "0", "the tool card is not shown with it");
      await page.screenshot({ path: "test-results/office-menu.png" }).catch(() => undefined);
    });

    await test("above the groups, a row of pinned icons: Bold, Italic, Cell colour and AutoSum to start with", async () => {
      const pinned = await frame.locator("#autora-menu .am-pins button").evaluateAll((bs) => bs.map((b) => b.getAttribute("aria-label")));
      assert.deepEqual(pinned.slice(0, 3), ["Bold", "Italic", "Cell colour"], pinned.join(", "));
      const above = await frame.evaluate(() => document.querySelector("#autora-menu .am-pins")!.getBoundingClientRect().bottom <= document.querySelector("#autora-menu [data-group]")!.getBoundingClientRect().top + 1);
      assert.ok(above, "the pins sit above the groups");
      assert.equal(await frame.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.group), "Formatting", "the keys start on the first group");
    });

    await test("Formatting opens beside it to Bold, Italic, Underline, Text colour and Cell colour", async () => {
      await page.keyboard.press("ArrowRight");
      await until("the Formatting entries", async () => (await frame.locator("#autora-menu .am-sub button").count()) > 0, 3_000);
      const items = (await frame.locator("#autora-menu .am-sub button span").allTextContents()).map((x) => x.trim());
      assert.deepEqual(items, ["Bold", "Italic", "Underline", "Text colour", "Cell colour"]);
      const beside = await frame.evaluate(() => {
        const list = document.querySelector("#autora-menu .am-list:not(.am-sub)")!.getBoundingClientRect();
        const sub = document.querySelector("#autora-menu .am-sub")!.getBoundingClientRect();
        return sub.left >= list.right - 4 || sub.right <= list.left + 4;
      });
      assert.ok(beside, "beside the list, not over it");
      await page.screenshot({ path: "test-results/office-menu-formatting.png" }).catch(() => undefined);
    });

    await test("an entry does what the editor's own command does, and the menu goes", async () => {
      await page.keyboard.press("Enter");
      assert.equal(await menuOpen(), false);
      await until("Bold to be on for the cell", async () => (await frame.locator('#autora-rail [aria-label="Bold"].on, #autora-rail [aria-label^="Bold"].on').count()) === 1, 5_000);
      await rightClick();
      await page.keyboard.press("ArrowRight");
      await until("Bold shown as on in the menu", async () => (await frame.locator("#autora-menu .am-sub button.on", { hasText: "Bold" }).count()) === 1, 3_000);
      await page.keyboard.press("Enter");
      await until("Bold off again", async () => (await frame.locator('#autora-rail [aria-label^="Bold"].on').count()) === 0, 5_000);
    });

    await test("an entry's pin puts it in the row, a pinned icon does its command, and the pins are kept", async () => {
      const focused = () => frame.evaluate(() => document.activeElement?.getAttribute("aria-label") || document.activeElement?.querySelector("span")?.textContent?.trim() || "");
      await rightClick();
      await page.keyboard.press("ArrowRight");
      await until("the Formatting entries", async () => (await frame.locator("#autora-menu .am-sub .am-row").count()) > 0, 3_000);
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowDown");
      assert.equal(await focused(), "Underline");
      assert.equal(await frame.locator('#autora-menu .am-sub [aria-label="Pin Underline to the top of the menu"]').count(), 1, "each entry has its pin");
      await page.keyboard.press("p");
      assert.equal(await frame.locator('#autora-menu .am-pins [aria-label="Underline"]').count(), 1, "pinned at once, with the menu still open");
      assert.equal(await frame.locator('#autora-menu .am-sub [aria-label="Unpin Underline"]').count(), 1, "its pin says so");
      await page.screenshot({ path: "test-results/office-menu-pins.png" }).catch(() => undefined);
      await page.keyboard.press("Escape");
      await rightClick();
      assert.equal(await frame.locator('#autora-menu .am-pins [aria-label="Underline"]').count(), 1, "still there next time");
      // Up from the first group into the pinned row; Underline was pinned last, so it is at the far end.
      await page.keyboard.press("ArrowUp");
      await page.keyboard.press("ArrowLeft");
      assert.equal(await focused(), "Underline");
      await page.keyboard.press("Enter");
      assert.equal(await menuOpen(), false);
      await until("Underline on for the cell", async () => (await frame.locator('#autora-rail [aria-label^="Underline"].on').count()) === 1, 5_000);
      await rightClick();
      await page.keyboard.press("ArrowUp");
      await page.keyboard.press("ArrowLeft");
      await page.keyboard.press("Enter");
      await until("Underline off again", async () => (await frame.locator('#autora-rail [aria-label^="Underline"].on').count()) === 0, 5_000);
      await rightClick();
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("p");
      assert.equal(await frame.locator('#autora-menu .am-pins [aria-label="Underline"]').count(), 0, "unpinned");
      await page.keyboard.press("Escape");
      assert.equal(await frame.evaluate(() => [...document.querySelectorAll("[data-u-comp='editor']")].map((e) => e.textContent ?? "").join("").trim()), "", "the P went to the menu, not into the cell");
    });

    await test("only what applies: on one cell, Data has no Sort & filter; on a block of cells, it does", async () => {
      await rightClick();
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowRight");
      await until("the Data entries", async () => (await frame.locator("#autora-menu .am-sub button").count()) > 0, 3_000);
      const one = await frame.locator("#autora-menu .am-sub button span").allTextContents();
      assert.ok(!one.includes("Sort & filter"), `one cell: ${one.join(", ")}`);
      await page.keyboard.press("Escape");
      await page.mouse.click(cell.x, cell.y);
      await page.keyboard.press("Shift+ArrowDown");
      await page.keyboard.press("Shift+ArrowRight");
      await sleep(400);
      await page.mouse.click(cell.x + 10, cell.y + 4, { button: "right" });
      await until("the menu", menuOpen, 5_000);
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowRight");
      await until("Sort & filter for a block", async () => (await frame.locator("#autora-menu .am-sub button span").allTextContents()).includes("Sort & filter"), 3_000);
    });

    await test("the keys work it: down to a group, right into it, Escape puts it away", async () => {
      await page.keyboard.press("Escape");
      assert.equal(await menuOpen(), false);
      await rightClick();
      await page.keyboard.press("ArrowRight");
      await until("Formatting's entries focused", async () => (await frame.evaluate(() => !!document.activeElement?.closest(".am-sub"))), 3_000);
      await page.keyboard.press("ArrowLeft");
      assert.equal(await frame.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.group), "Formatting");
      await page.keyboard.press("Escape");
      assert.equal(await menuOpen(), false);
    });

    await test("a click elsewhere or a wheel puts it away", async () => {
      await rightClick();
      await page.mouse.click(cell.x + 300, cell.y + 200);
      assert.equal(await menuOpen(), false);
      await rightClick();
      await page.mouse.wheel(0, 120);
      await until("the menu to go", async () => !(await menuOpen()), 3_000);
    });
  } finally {
    await browser.close();
    await app.stop();
  }
  console.log(`\n${passed} passed`);
}

main().catch((err) => { console.error(err); process.exit(1); });
