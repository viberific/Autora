/**
 * The desktop's three panes can be dragged to the width the person wants, the menu on
 * the left can be folded away to the far left (and brought back), and it is all
 * remembered. A phone is left alone.
 *
 *   npx tsx tests/ui-panes.test.ts
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
  const exe = process.env.AUTORA_BROWSER_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
  if (!fs.existsSync(exe)) { console.log("  skip  no browser here"); return; }
  if (!fs.existsSync("dist/index.html")) { console.log("  skip  the app is not built"); return; }
  const app = await startApp();
  const browser = await chromium.launch({ executablePath: exe });
  try {
    const s = await app.newSession("Panes", "build");
    // A document beside the conversation: PDF is the cheapest window to open.
    app.decide = (req) => (/You check one action/.test(req.system) ? { text: '{"destructive": false, "requested": true}' } : req.tools.length === 0 ? { text: "SKIP" } : { text: "Hello." });
    await app.turn(s, "hi");
    await app.api("POST", `/api/pdfdesk/${s}/blank`).catch(() => undefined);

    const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
    await page.goto(`${app.base}/?session=${s}`);
    const width = (sel: string) => page.locator(sel).first().evaluate((el) => Math.round(el.getBoundingClientRect().width));
    await page.waitForSelector(".rail-slot");

    await test("dragging the seam by the menu changes its width, and it is remembered", async () => {
      const before = await width(".rail-slot");
      const h = (await page.locator(".pane-handle.is-rail").boundingBox())!;
      await page.mouse.move(h.x + h.width / 2, h.y + 200);
      await page.mouse.down();
      await page.mouse.move(h.x + h.width / 2 + 80, h.y + 200, { steps: 6 });
      await page.mouse.up();
      const after = await width(".rail-slot");
      assert.ok(after >= before + 70 && after <= before + 90, `${before} -> ${after}`);
      await page.reload();
      await page.waitForSelector(".rail-slot");
      assert.equal(await width(".rail-slot"), after);
    });

    await test("it keeps to its limits, and a double click puts it back", async () => {
      const h = (await page.locator(".pane-handle.is-rail").boundingBox())!;
      await page.mouse.move(h.x + 3, h.y + 200);
      await page.mouse.down();
      await page.mouse.move(h.x + 900, h.y + 200, { steps: 4 });
      await page.mouse.up();
      assert.ok((await width(".rail-slot")) <= 520);
      await page.locator(".pane-handle.is-rail").dblclick();
      const back = await width(".rail-slot");
      // 0.9.289: the reset width is no longer a constant. The menu is put back as the WHOLE menu -- wide enough for its
      // words, measured from the labels themselves -- so the old 150-180 expectation asserted a number the app stopped
      // using when it began measuring what the words need (R13). What matters is that it comes back as words and not as
      // the strip of icons, and that it is a width a whole menu can be.
      assert.ok(back >= 150 && back <= 280, `put back to ${back}px, which is not a whole menu`);
      assert.equal(await page.locator(".app").evaluate((el) => el.classList.contains("rail-icons")), false, "the reset puts the words back, not the icons");
    });

    await test("a desktop has no way to fold the menu away: it is whole or icons, and no menu button", async () => {
      assert.equal(await page.getByRole("button", { name: "Fold the menu away" }).count(), 0);
      assert.equal(await page.locator(".menu-btn").isVisible(), false);
      // Folded away by an older version: still shown.
      await page.evaluate(() => localStorage.setItem("autora.panes", JSON.stringify({ ...JSON.parse(localStorage.getItem("autora.panes") ?? "{}"), collapsed: true })));
      await page.reload();
      await page.waitForSelector(".rail-slot .rail-nav");
      assert.notEqual(await page.locator(".rail-slot").evaluate((el) => getComputedStyle(el).display), "none");
    });

    await test("with a document open beside the conversation, the seam between them drags too, and the window keeps room", async () => {
      const d = await app.newSession("Panes with a document", "build");
      let n = 0;
      app.decide = (req) => {
        if (/You check one action/.test(req.system)) return { text: '{"destructive": false, "requested": true}' };
        if (req.tools.length === 0) return { text: "SKIP" };
        n += 1;
        return n === 1 ? { tools: [{ name: "office_create", args: { type: "docx", name: "memo", markdown: "# Memo\n\nHello.\n" } }] } : { text: "Made." };
      };
      await app.turn(d, "make a memo", 120_000);
      const p2 = await browser.newPage({ viewport: { width: 1500, height: 900 } });
      await p2.goto(`${app.base}/?session=${d}`);
      await p2.waitForSelector(".pane-handle.is-chat", { state: "visible", timeout: 30_000 });
      const w = (sel: string) => p2.locator(sel).first().evaluate((el) => Math.round(el.getBoundingClientRect().width));
      /* This window has never been sized, so its menu opens as the strip of
         icons (RAIL.fallback). The whole menu is asked for first, because what
         follows is about folding it away and giving its room to the window. */
      const whole = p2.getByRole("button", { name: "Show the whole menu" });
      if (await whole.count()) { await whole.click(); await sleep(300); }
      const before = await w(".chat-view.has-app > .page");
      const h = (await p2.locator(".pane-handle.is-chat").boundingBox())!;
      await p2.mouse.move(h.x + h.width / 2, h.y + 300);
      await p2.mouse.down();
      await p2.mouse.move(h.x + h.width / 2 + 100, h.y + 300, { steps: 6 });
      await p2.mouse.up();
      const after = await w(".chat-view.has-app > .page");
      assert.ok(after >= before + 90 && after <= before + 110, `${before} -> ${after}`);
      // Dragged as far as it goes, the window beside it still has room.
      const h2 = (await p2.locator(".pane-handle.is-chat").boundingBox())!;
      await p2.mouse.move(h2.x + 3, h2.y + 300);
      await p2.mouse.down();
      await p2.mouse.move(h2.x + 1200, h2.y + 300, { steps: 6 });
      await p2.mouse.up();
      assert.ok((await w(".app-pane:not([hidden])")) >= 300, `the window has ${await w(".app-pane:not([hidden])")}px`);
      await p2.locator(".pane-handle.is-chat").dblclick();
      assert.ok((await w(".chat-view.has-app > .page")) <= 540);
      // A smaller menu gives its room to the window, never to the conversation.
      const chatWas = await w(".chat-view.has-app > .page");
      const windowWas = await w(".app-pane:not([hidden])");
      await p2.getByRole("button", { name: "Fold the menu to icons" }).click();
      await sleep(400);
      assert.equal(await w(".chat-view.has-app > .page"), chatWas, "the conversation keeps its width");
      assert.ok((await w(".app-pane:not([hidden])")) > windowWas + 100, "the window is wider");
      await p2.getByRole("button", { name: "Show the whole menu" }).click();
    });

    await test("with a window open beside the chat, the header's name and permissions pill are not under it", async () => {
      /* The window beside the chat starts above the header and covers its right part, so what the header holds has to fit
         in the chat column: the name gives way with an ellipsis, and the pill (Yolo / Ask) stays where it can be clicked.
         A fresh browser, so no pane has been dragged to a width that hides the overlap. */
      const t = await app.newSession("A fairly long session title to see how it truncates in the header", "build");
      app.decide = (req) => {
        if (/You check one action/.test(req.system)) return { text: '{"destructive": false, "requested": true}' };
        if (req.tools.length === 0) return { text: "SKIP" };
        return req.messages.some((m) => m.role === "tool") ? { text: "Done." } : { tools: [{ name: "terminal", args: { command: "echo hi" } }] };
      };
      await app.turn(t, "run it", 120_000);
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const p3 = await ctx.newPage();
      await p3.goto(`${app.base}/?session=${t}`);
      await p3.waitForSelector(".chat-view.has-app > .side-stack", { timeout: 30_000 });
      for (const sel of [".top .session-btn", ".top .badge.mode-pill"]) {
        const reached = await p3.locator(sel).first().evaluate((el) => {
          const r = el.getBoundingClientRect();
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return hit === el || el.contains(hit);
        });
        assert.ok(reached, `${sel} is under the window beside the chat`);
      }
      await ctx.close();
    });

    await test("the menu folds to icons, with the context as one bar under the last icon, and comes back whole", async () => {
      await page.getByRole("button", { name: "Fold the menu to icons" }).click();
      await sleep(300);
      assert.ok((await width(".rail-slot")) <= 80, "a strip of icons");
      assert.equal(await page.locator(".rail-nav-item > span:visible").count(), 0, "no words beside the icons");
      const last = (await page.locator('.rail-nav-item[data-page="system"]').boundingBox())!;
      const bar = (await page.locator(".rail-ctxbar-track").boundingBox())!;
      const rail = (await page.locator(".rail-slot").boundingBox())!;
      assert.ok(bar.y > last.y + last.height - 1, "the bar starts under the last icon");
      assert.ok(bar.y + bar.height <= rail.y + rail.height && bar.y + bar.height > rail.y + rail.height - 40, "and runs to the foot of the strip");
      // The way back and New session are in the header, just right of the strip, left of the chat's name.
      const back = (await page.getByRole("button", { name: "Show the whole menu" }).boundingBox())!;
      const plus = (await page.locator(".top-rail-acts").getByRole("button", { name: "New session" }).boundingBox())!;
      const name = (await page.locator(".session-btn").boundingBox())!;
      assert.ok(back.x >= rail.x + rail.width && back.x < rail.x + rail.width + 40 && back.y < 60, `the way back sits beside the strip (${back.x}, ${back.y})`);
      assert.ok(plus.x > back.x && plus.x + plus.width <= name.x && Math.abs(plus.y - back.y) < 4, "New session beside it, before the name, on one row");
      await page.reload();
      await page.waitForSelector(".rail-ctxbar");
      await page.getByRole("button", { name: "Show the whole menu" }).click();
      await sleep(300);
      assert.ok((await width(".rail-slot")) > 140, "the whole menu is back");
      assert.equal(await page.locator(".rail-ctxbar").count(), 0);
    });

    await test("on a phone nothing of this appears", async () => {
      const phone = await browser.newPage({ viewport: { width: 390, height: 800 } });
      await phone.goto(`${app.base}/?session=${s}`);
      await sleep(1500);
      assert.equal(await phone.locator(".pane-handle.is-rail").evaluate((el) => getComputedStyle(el).display), "none");
      assert.ok(await phone.locator(".menu-btn").isVisible());
    });
  } finally {
    await browser.close();
    await app.stop();
  }
  console.log(`\n${passed} passed`);
}
main().then(() => process.exit(0), (err) => { console.error(err); process.exit(1); });
