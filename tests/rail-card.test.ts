/**
 * Sheets on a desktop (office/shim/rail.js) has no tool card: a click, the keys, a wheel or a resize bring nothing up over
 * the grid, which the person asked for. Its tools are the right-click menu (tests/ui-office-menu.test.ts).
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
  };

  await test("a click on a cell brings up nothing: Sheets has no tool card on a desktop", async () => {
    await fresh();
    await page.mouse.click(300, 200);
    await page.waitForTimeout(250);
    assert.equal(await open(), false);
    assert.equal(await frame.evaluate(() => getComputedStyle(document.getElementById("autora-rail")!).visibility), "hidden");
  });

  await test("nor do the keys moving the pick, a wheel or a resize", async () => {
    await fresh();
    await page.mouse.click(300, 200);
    await page.keyboard.press("ArrowDown");
    await page.mouse.move(400, 400);
    await page.mouse.wheel(0, 200);
    await page.evaluate(() => { document.querySelector("iframe")!.style.width = "800px"; });
    await page.waitForTimeout(250);
    assert.equal(await open(), false);
  });

  await test("the formula bar is kept out of the way, not left in its strip over the grid", async () => {
    await fresh();
    await page.mouse.click(300, 200);
    await page.waitForTimeout(150);
    const left = await frame.evaluate(() => document.querySelector("[data-u-comp='formula-bar']")!.getBoundingClientRect().left);
    assert.ok(left < -1000, `the formula bar is at ${left}`);
  });

  await test("All tools dims and frosts behind it with the page's own scrim, sent to the frame with the theme (R18)", async () => {
    await fresh();
    const look = await frame.evaluate(() => {
      document.documentElement.style.setProperty("--autora-scrim", "rgba(1, 2, 3, 0.5)");
      document.documentElement.style.setProperty("--autora-scrim-blur", "blur(10px) saturate(1.4)");
      (document.querySelector('#autora-rail button[aria-label="All tools"]') as HTMLButtonElement).click();
      const css = getComputedStyle(document.getElementById("autora-grid")!);
      return { bg: css.backgroundColor, blur: css.backdropFilter };
    });
    assert.deepEqual(look, { bg: "rgba(1, 2, 3, 0.5)", blur: "blur(10px) saturate(1.4)" });
  });
} finally {
  await browser.close();
}
console.log(`\n${passed} passed`);
