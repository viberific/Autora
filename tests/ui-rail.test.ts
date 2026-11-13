/**
 * The menu on the left, on a desktop: opened, its words are said once (the hidden copy it measures them from is never
 * seen), there is no Store, it is only as wide as its words need, and the whole list with its widgets fits a laptop's
 * height without scrolling -- opened or folded to icons.
 *
 *   npx tsx tests/ui-rail.test.ts      (needs `npm run build`)
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { chromium, type Page } from "playwright-core";
import { startApp } from "./e2e-harness";
import { CHROME } from "./chrome";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

async function main() {
  if (!fs.existsSync(CHROME)) { console.log("  skip  no browser here"); return; }
  if (!fs.existsSync("dist/index.html")) { console.log("  skip  the app is not built (npm run build)"); return; }
  const app = await startApp();
  const browser = await chromium.launch({ executablePath: CHROME });
  const scrolls = (page: Page) => page.evaluate(() => { const el = document.querySelector(".rail-scroll") as HTMLElement; return el.scrollHeight - el.clientHeight; });
  try {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
    await page.goto(`${app.base}/?page=sessions`);
    await page.waitForSelector(".rail .rail-nav");
    if (await page.locator(".rail.is-mini").count()) await page.locator('.top-rail-acts [aria-label="Show the whole menu"]').click();
    await page.waitForSelector(".rail:not(.is-mini)");
    await page.waitForTimeout(500);

    await test("opened, each word is drawn once: the copy it is measured from is not seen", async () => {
      const seen = await page.evaluate(() => {
        const out: string[] = [];
        for (const el of document.querySelectorAll(".rail span")) {
          const r = el.getBoundingClientRect();
          if (r.width && getComputedStyle(el).visibility === "visible" && /^(Chat|Sessions|Organization|System)$/.test(el.textContent ?? "")) out.push(el.textContent!);
        }
        return out;
      });
      assert.deepEqual(seen.sort(), ["Chat", "Organization", "Sessions", "System"]);
    });

    await test("there is no Store", async () => {
      assert.equal(await page.locator('.rail [data-page="store"]').count(), 0);
      assert.equal(await page.locator(".rail-nav-item", { hasText: "Store" }).count(), 0);
    });

    await test("it is as wide as its words, with no dead space after them", async () => {
      const fit = await page.evaluate(() => {
        const rail = document.querySelector(".rail")!.getBoundingClientRect();
        const ends = [...document.querySelectorAll(".rail-nav .rail-nav-item > span")].map((s) => s.getBoundingClientRect().right);
        return { width: rail.width, spare: rail.right - Math.max(...ends), cut: [...document.querySelectorAll(".rail-nav .rail-nav-item > span")].some((s) => s.scrollWidth > s.clientWidth + 1) };
      });
      assert.ok(fit.width <= 150, `the menu is ${fit.width}px`);
      assert.ok(fit.spare <= 40, `${fit.spare}px after the widest word`);
      assert.equal(fit.cut, false, "no word is cut");
    });

    await test("the whole list and its widgets fit a 720px window without scrolling", async () => {
      assert.ok((await scrolls(page)) <= 0, `it scrolls ${await scrolls(page)}px`);
    });

    await test("on a tall screen the latest chats fill the room between the pages and the cards, whole rows only", async () => {
      for (let i = 0; i < 30; i += 1) await app.newSession(`Chat number ${i}`, "build");
      const tall = await (await browser.newContext({ viewport: { width: 1280, height: 1900 } })).newPage();
      await tall.goto(`${app.base}/?page=sessions`);
      await tall.waitForSelector(".rail-recent-row");
      if (await tall.locator(".rail.is-mini").count()) await tall.locator('.top-rail-acts [aria-label="Show the whole menu"]').click();
      await tall.waitForTimeout(600);
      const recent = await tall.evaluate(() => {
        const box = document.querySelector(".rail-recent")!.getBoundingClientRect();
        const rows = [...document.querySelectorAll<HTMLElement>(".rail-recent-row:not([hidden])")].map((r) => r.getBoundingClientRect());
        return { rows: rows.length, inside: rows.every((r) => r.bottom <= box.bottom + 0.5), names: [...document.querySelectorAll(".rail-recent-row span")].map((n) => n.textContent), height: box.height };
      });
      assert.ok(recent.rows >= 10, `${recent.rows} chats shown in ${Math.round(recent.height)}px`);
      assert.equal(recent.inside, true, "no row is cut at the foot");
      const order = ((await app.api("GET", "/api/sessions")).body as { title: string }[]).map((r) => r.title);
      assert.deepEqual(recent.names, order.slice(0, recent.names.length), "in the Sessions list's order: pinned, then latest");
      assert.ok((await scrolls(tall)) <= 0, "the tall menu does not scroll");
      await tall.close();
      // The short window still fits with no scrolling, and shows no half rows.
      await page.reload();
      await page.waitForSelector(".rail .rail-nav");
      await page.waitForTimeout(500);
      assert.ok((await scrolls(page)) <= 0, `it scrolls ${await scrolls(page)}px`);
    });

    await test("folded to icons, too", async () => {
      await page.locator('.rail [aria-label="Fold the menu to icons"]').click();
      await page.waitForSelector(".rail.is-mini");
      await page.waitForTimeout(400);
      assert.ok((await scrolls(page)) <= 0, `it scrolls ${await scrolls(page)}px`);
    });
  } finally {
    await browser.close();
    await app.stop();
  }
  console.log(`\n${passed} passed`);
}

main().catch((err) => { console.error(err); process.exit(1); });
