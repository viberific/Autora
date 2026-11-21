/**
 * Pulling a Panacea window by its corner on a phone never makes it taller without making it larger.
 *
 * A phone holds a window to its screen's width (a max-width on the window). The corner pull grew the *stored* width, which
 * was already past what is drawn, and the stored height with it: so once the window was as wide as the screen, every pull
 * made it taller while its width and its content stayed put. Now a pull starts from the size that is drawn and stops where
 * the screen does.
 *
 *   npx tsx tests/ui-window-resize.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { chromium, type Page } from "playwright-core";
import { sleep, startApp } from "./e2e-harness";
import { CHROME } from "./chrome";
import { openWorkButtons } from "./ui-workspace-ready";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

async function main() {
  if (!fs.existsSync(CHROME)) { console.log("  skip  no browser here"); return; }
  if (!fs.existsSync("dist/index.html")) { console.log("  skip  the app is not built"); return; }
  const app = await startApp();
  const browser = await chromium.launch({ executablePath: CHROME });
  try {
    fs.mkdirSync(`${app.home}/site`, { recursive: true });
    fs.writeFileSync(`${app.home}/site/index.html`, fs.readFileSync("tests/fixtures/bike-site.html", "utf8"));
    const s = await app.newSession("Resize", "build");
    app.decide = (req) => req.messages.some((m) => m.role === "tool")
      ? { text: "Open." } : { tools: [{ name: "app_preview", args: { action: "start", dir: "site" } }] };
    await app.turn(s, "build the site", 60_000);
    app.decide = null;

    // Phone width, and tall enough that the window's corner is on screen.
    const phone = await browser.newContext({ viewport: { width: 390, height: 1800 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
    const p: Page = await phone.newPage();
    await p.goto(`${app.base}/?session=${s}`);
    await p.waitForSelector(".app-screen", { timeout: 20_000 });
    await sleep(2500);
    await openWorkButtons(p);
    await sleep(800);
    // The conversation floats over the board, and over the corner: out of the way, so the pull is the corner's.
    await p.addStyleTag({ content: ".thread, .thread-content, .conversation-flow, .composer { pointer-events: none !important; }" });

    const size = () => p.evaluate(() => {
      const w = document.querySelector('.pw-engine[data-engine="app"]') as HTMLElement;
      const c = document.querySelector(".app-canvas") as HTMLElement;
      const h = (w.querySelector(".pa-resize") as HTMLElement).getBoundingClientRect();
      const hit = document.elementFromPoint(h.x + h.width / 2, h.y + h.height / 2) as HTMLElement | null;
      return { w: w.offsetWidth, h: w.offsetHeight, cw: Math.round(c.getBoundingClientRect().width), reachable: !!hit?.classList.contains("pa-resize") };
    });
    const pull = async (dx: number, dy: number) => {
      const hb = (await p.locator('.pw-engine[data-engine="app"] .pa-resize').first().boundingBox())!;
      const x = hb.x + hb.width / 2, y = hb.y + hb.height / 2;
      await p.mouse.move(x, y);
      await p.mouse.down();
      for (let i = 1; i <= 10; i++) { await p.mouse.move(x + (dx * i) / 10, y + (dy * i) / 10); await sleep(12); }
      await p.mouse.up();
      await sleep(700);
    };

    await test("the corner can be reached, and the window is no wider than the screen", async () => {
      const at = await size();
      assert.ok(at.reachable, "the pull lands on the handle, not on something over it");
      assert.ok(at.w <= 390 - 16, `no wider than the screen (${at.w})`);
    });

    await test("pulling the corner out grows the window and its content together", async () => {
      await pull(-60, -30); // settle it to the shape of its page first
      const before = await size();
      await pull(40, 20);
      const after = await size();
      assert.ok(after.w > before.w + 10, `wider (${before.w} -> ${after.w})`);
      assert.ok(after.cw > before.cw + 10, `and the content grew with it (${before.cw} -> ${after.cw})`);
    });

    await test("once it is as wide as the screen, pulling further does not just make it taller", async () => {
      await pull(80, 40); // to the screen's width
      const atCap = await size();
      assert.ok(atCap.w <= 390 - 16, `not past the screen (${atCap.w})`);
      for (let i = 0; i < 3; i++) await pull(100, 50);
      const after = await size();
      assert.deepEqual({ w: after.w, h: after.h, cw: after.cw }, { w: atCap.w, h: atCap.h, cw: atCap.cw },
        `nothing grew beyond the screen's width: before ${JSON.stringify(atCap)}, after ${JSON.stringify(after)}`);
    });
    console.log(`\n${passed} passed`);
  } finally {
    await browser.close();
    await app.stop();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
