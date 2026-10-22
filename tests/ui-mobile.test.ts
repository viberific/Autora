/**
 * What a phone on its side, a phone with the keyboard up and a tablet need that a portrait phone does not show: touch-sized
 * buttons keyed to the pointer rather than the width, a composer that cannot fill the screen it is typed on, and a table
 * that scrolls instead of breaking its words.
 *
 *   npx tsx tests/ui-mobile.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { chromium } from "playwright-core";
import { startApp } from "./e2e-harness";

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
    app.decide = (req) => ({ text: /^table/.test(req.last)
      ? "| a | b | c | d | e | f |\n|---|---|---|---|---|---|\n| one long cell here | two long cell here | three long cell here | four long cell here | five long cell here | six long cell here |"
      : "ok" });
    const s = await app.newSession("Mobile");
    await app.turn(s, "table please");
    await app.api("POST", "/api/triggers", { name: "Nightly", prompt: "look" });
    const phone = async (w: number, h: number) => {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
      return { ctx, page: await ctx.newPage() };
    };

    await test("a table's cells break at spaces, never inside a word, on a phone", async () => {
      const { ctx, page } = await phone(390, 800);
      await page.goto(`${app.base}/?page=chat&session=${s}`);
      await page.locator(".md table td").first().waitFor();
      // A word that wraps in the middle has a rectangle on each line it spans: count the words that do.
      const broken = await page.evaluate(() => {
        let split = 0;
        for (const cell of Array.from(document.querySelectorAll(".md td, .md th"))) {
          const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
          for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            for (const m of (n.textContent ?? "").matchAll(/\S+/g)) {
              const r = document.createRange();
              r.setStart(n, m.index!); r.setEnd(n, m.index! + m[0].length);
              if (new Set(Array.from(r.getClientRects()).map((q) => Math.round(q.top))).size > 1) split += 1;
            }
          }
        }
        return split;
      });
      assert.equal(broken, 0, `${broken} words in the table are broken across lines`);
      await ctx.close();
    });

    await test("with the keyboard up, a long message cannot fill the screen: it scrolls and Send stays on it", async () => {
      for (const [w, h] of [[390, 330], [844, 215]] as const) {
        const { ctx, page } = await phone(w, h);
        await page.goto(`${app.base}/?page=chat&session=${s}`);
        const ta = page.locator("textarea").first();
        await ta.fill(Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n"));
        await page.waitForTimeout(300);
        const r = await page.evaluate(() => {
          const t = document.querySelector("textarea") as HTMLElement; const b = t.getBoundingClientRect();
          const send = document.querySelector(".composer-send, button[aria-label*='end']") as HTMLElement | null;
          const sr = send?.getBoundingClientRect();
          return { th: b.height, H: innerHeight, sendIn: sr ? sr.top >= 0 && sr.bottom <= innerHeight + 1 : null };
        });
        assert.ok(r.th <= r.H * 0.4, `${w}x${h}: the box is ${Math.round(r.th)}px of ${r.H}`);
        if (r.sendIn !== null) assert.ok(r.sendIn, `${w}x${h}: Send is off the screen`);
        await ctx.close();
      }
    });

    await test("buttons are finger-sized by the pointer, not only on a narrow screen (a phone on its side, a tablet)", async () => {
      for (const [w, h] of [[844, 390], [768, 1024]] as const) {
        const { ctx, page } = await phone(w, h);
        await page.goto(`${app.base}/?page=triggers`);
        await page.locator("button[aria-label*='elete'], button[title*='elete']").first().tap();
        const heights = await page.locator(".modal.sure .modal-foot .btn").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
        assert.ok(heights.length >= 2 && heights.every((x) => x >= 38), `${w}x${h}: dialog buttons are ${heights.join(", ")}px`);
        await ctx.close();
      }
    });
  } finally {
    await browser.close();
    await app.stop();
  }
  console.log(`\n${passed} passed`);
}
main().then(() => process.exit(0), (err) => { console.error(err); process.exit(1); });
