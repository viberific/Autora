/**
 * Sheets' card on a desktop (office/shim/rail.js) belongs to the cell it came to (R17b): it sits at a point on the screen,
 * so it goes as soon as the view moves under it (a wheel over the grid, the keys moving the pick, the window resized)
 * instead of staying put while the cell slides away -- but not for the shim's own made-up resizes, and not while a
 * formula is being typed in its bar. Its formula bar stays laid over its slot in the card as the card's rows change.
 * The real shim is run in Chromium in a stand-in for the editor's frame (a name box, a grid, a formula bar).
 *
 *   npx tsx tests/rail-card.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium, type Frame } from "playwright-core";
import { CHROME } from "./chrome";

const here = import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname);
const shim = fs.readFileSync(path.join(here, "../office/shim/rail.js"), "utf8");
const icons = fs.readFileSync(path.join(here, "../office/shim/rail-icons.js"), "utf8");

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

const editor = `<!doctype html><html><body style="margin:0">
  <div data-u-comp="defined-name"><input value="B2"></div>
  <div data-u-comp="formula-bar" style="height:28px"><input id="fx"></div>
  <div id="univer-container" style="width:900px;height:600px;background:#eee"></div>
  <script>${icons}</script><script>${shim}</script></body></html>`;

if (!fs.existsSync(CHROME)) { console.log("  skip  no browser here"); process.exit(0); }
const browser = await chromium.launch({ executablePath: CHROME });
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  await page.route("http://autora.test/**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/top.html") return route.fulfill({ contentType: "text/html", body: `<iframe src="/office-app/sheets/index.html" style="width:960px;height:660px;border:0"></iframe>` });
    return route.fulfill({ contentType: "text/html", body: editor });
  });
  let frame: Frame;
  const open = async () => frame.evaluate(() => document.getElementById("autora-rail")?.getAttribute("data-open") === "1");
  const fresh = async () => {
    await page.goto("http://autora.test/top.html");
    frame = page.frames().find((f) => f.url().includes("/sheets/"))!;
    await frame.waitForSelector("#autora-rail", { state: "attached" });
    // A click on the grid brings the card to the cell.
    await page.mouse.click(300, 200);
    await frame.waitForFunction(() => document.getElementById("autora-rail")?.getAttribute("data-open") === "1");
  };

  await test("a click on a cell brings the card, and the shim's own made-up resizes leave it there", async () => {
    await fresh();
    await frame.evaluate(() => { window.dispatchEvent(new Event("resize")); document.documentElement.classList.add("rail-ribbon"); document.documentElement.classList.remove("rail-ribbon"); });
    await page.waitForTimeout(150);
    assert.equal(await open(), true);
  });

  await test("a wheel over the grid takes the card away rather than leaving it off its cell", async () => {
    await fresh();
    await page.mouse.move(400, 400);
    await page.mouse.wheel(0, 200);
    await frame.waitForFunction(() => document.getElementById("autora-rail")?.getAttribute("data-open") === "0");
  });

  await test("the keys moving the pick to another cell take it away", async () => {
    await fresh();
    await page.keyboard.press("ArrowDown");
    assert.equal(await open(), false);
  });

  await test("the window resized takes it away", async () => {
    await fresh();
    await page.evaluate(() => { document.querySelector("iframe")!.style.width = "800px"; });
    await frame.waitForFunction(() => document.getElementById("autora-rail")?.getAttribute("data-open") === "0");
  });

  await test("a formula being typed in its bar stays with the person through a wheel, laid over its slot as the card changes", async () => {
    await fresh();
    await frame.focus("#fx");
    await frame.waitForFunction(() => document.documentElement.classList.contains("fx-on"));
    await page.mouse.move(400, 400);
    await page.mouse.wheel(0, 200);
    await page.waitForTimeout(100);
    assert.equal(await open(), true);
    // The card moves (as it does when its rows change); the bar is measured again and follows its slot.
    await frame.evaluate(() => { const bar = document.getElementById("autora-rail")!; bar.style.left = "40px"; bar.style.top = "300px"; });
    await page.waitForTimeout(100);
    const fit = await frame.evaluate(() => {
      const slot = document.querySelector(".fx-slot")!.getBoundingClientRect();
      const fb = document.querySelector("[data-u-comp='formula-bar']")!.getBoundingClientRect();
      return { dx: Math.abs(slot.left - fb.left), dy: Math.abs(slot.top - fb.top) };
    });
    assert.ok(fit.dx <= 1 && fit.dy <= 1, `the formula bar is ${fit.dx},${fit.dy}px off its slot`);
  });
} finally {
  await browser.close();
}
console.log(`\n${passed} passed`);
