/**
 * The browser window on a phone: the paired-down one. A toolbar of back, reload, the address, drag and enlarge (no window
 * bar over it, no strip of tabs while there is one); Enlarge goes straight to full screen, magnified, with one button for
 * the page's size; and the toolbar is on top of the app's own header, not under it.
 *
 *   npx tsx tests/ui-browser-phone.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { chromium } from "playwright-core";
import { startApp } from "./e2e-harness";
import { CHROME } from "./chrome";
import { openWorkButtons } from "./ui-workspace-ready";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

async function main() {
  const exe = CHROME;
  if (!fs.existsSync(exe)) { console.log("  skip  no browser here"); return; }
  if (!fs.existsSync("dist/index.html")) { console.log("  skip  the app is not built"); return; }
  const app = await startApp();
  const browser = await chromium.launch({ executablePath: exe });
  try {
    const s = await app.newSession("Browse", "build");
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    await page.goto(`${app.base}/?session=${s}`);
    await page.waitForSelector(".composer", { timeout: 20_000 });
    let n = 0;
    app.decide = (req) => {
      if (/You check one action/.test(req.system)) return { text: '{"destructive": false, "requested": true}' };
      if (req.tools.length === 0) return { text: "SKIP" };
      return n++ === 0 ? { tools: [{ name: "browser_open", args: { url: `${app.base}/?page=tools` } }] } : { text: "Opened." };
    };
    await app.turn(s, "open the app's tools page", 120_000);
    await page.waitForSelector('.pw-engine[data-engine="browser"] .cell.shot', { timeout: 30_000 });
    await openWorkButtons(page);
    await page.getByRole("navigation", { name: "Jump to work" }).getByRole("button", { name: "Jump to Web", exact: true }).click();

    await test("the toolbar is the window: no bar of its own, no tab strip for one tab, and thumb-sized buttons", async () => {
      assert.equal(await page.locator('.pw-engine[data-engine="browser"] .cell.shot .pdf-bar').count(), 0);
      assert.equal(await page.locator('.pw-engine[data-engine="browser"] .cell.shot .shot-tabs').count(), 0);
      assert.equal(await page.locator('.pw-engine[data-engine="browser"] .cell.shot .shot-address input').count(), 1);
      const sizes = await page.evaluate(() => [...document.querySelectorAll('.pw-engine[data-engine="browser"] .cell.shot .cell-top button')].filter((b) => b.getClientRects().length > 0).map((b) => (b as HTMLElement).offsetHeight));
      assert.ok(sizes.length >= 3 && sizes.every((height) => height >= 40), `logical buttons: ${sizes.join(" ")}`);
    });

    await test("Enlarge is full screen at once, magnified, with one button for the size; the toolbar is above the app's header", async () => {
      await page.locator('.pw-engine[data-engine="browser"] .cell.shot .shot-corner').click();
      await page.waitForSelector(".cell.shot.is-max", { timeout: 10_000 });
      assert.match(await page.locator(".shot-zoom-cycle").innerText(), /2×/);
      const top = await page.evaluate(() => {
        const el = document.querySelector(".cell.shot.is-max .cell-top")!;
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + 30, r.top + r.height / 2);
        return { y: Math.round(r.top), inside: !!hit && !!hit.closest(".cell.shot.is-max") };
      });
      assert.ok(top.y >= 0 && top.inside, `the toolbar is covered: ${JSON.stringify(top)}`);
      await page.locator(".shot-zoom-cycle").click();
      assert.match(await page.locator(".shot-zoom-cycle").innerText(), /3×/);
      await page.locator(".cell.shot.is-max .shot-corner").click();
      await page.waitForSelector(".cell.shot.is-max", { state: "detached", timeout: 10_000 });
    });

    await test("a finger's drag moves the picture at once, and each scroll step is answered without waiting for the page to settle", async () => {
      await page.locator('.pw-engine[data-engine="browser"] .cell.shot .shot-corner').click();
      await page.waitForSelector(".cell.shot.is-max .shot-stage.is-dragging-page img.frame", { timeout: 10_000 });
      const took: number[] = [];
      const began = new Map<object, number>();
      page.on("request", (r) => { if (r.url().endsWith("/browser/scroll")) began.set(r, Date.now()); });
      page.on("requestfinished", (r) => { const t = began.get(r); if (t) took.push(Date.now() - t); });
      const box = (await page.locator(".cell.shot.is-max img.frame").boundingBox())!;
      const x = Math.round(box.x + box.width / 2);
      const y0 = Math.round(box.y + box.height * 0.7);
      const cdp = await ctx.newCDPSession(page);
      const touch = (type: string, y: number) => cdp.send("Input.dispatchTouchEvent", {
        type, touchPoints: type === "touchEnd" ? [] : [{ x, y, id: 1 }],
      });
      await touch("touchStart", y0);
      let moved = false;
      for (let i = 1; i <= 12; i++) {
        await touch("touchMove", y0 - i * 12);
        await page.waitForTimeout(16);
        if (i === 3) {
          // Three moves in, about 50 ms: no picture of the scroll can be back yet, and the one on screen is already moved.
          moved = await page.evaluate(() => /translate3d\(0px, -[1-9]/.test(
            (document.querySelector(".cell.shot.is-max img.frame") as HTMLElement).style.transform));
        }
      }
      await touch("touchEnd", y0 - 144);
      await page.waitForTimeout(1500);
      assert.ok(moved, "the picture did not move under the finger before the server answered");
      assert.ok(took.length >= 2, `scroll steps sent: ${took.length}`);
      // Each step used to wait up to 150 ms for the page to go quiet and then map its fields: 210-310 ms a step here.
      const median = [...took].sort((a, b) => a - b)[Math.floor(took.length / 2)];
      assert.ok(median < 160, `a scroll step takes ${median} ms (each one waits for the page to settle): ${took.join(" ")}`);
      await page.locator(".cell.shot.is-max .shot-corner").click();
      await page.waitForSelector(".cell.shot.is-max", { state: "detached", timeout: 10_000 });
    });
  } finally {
    await browser.close();
    await app.stop();
  }
  console.log(`\n${passed} passed`);
}

main().then(() => process.exit(0), (err) => { console.error(err); process.exit(1); });
