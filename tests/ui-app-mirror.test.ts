/**
 * The app window (the Creator) draws the page as a live copy of its DOM, not as a stream of pictures -- the fix the
 * browser got, for the same reason: with pictures, every scroll, hover and tap waited on a round trip to the server and
 * then on the next frame. In a real browser, on the built app:
 *
 *   - the copy is drawn, and once it is, the server's Chrome stops sending pictures for the window;
 *   - a wheel scroll moves the copy at once, and the real page follows;
 *   - a finger swipe on a phone scrolls the copy (the window's `touch-action: none` must not swallow it);
 *   - a click in Use reaches the real page;
 *   - the browser's own copy and the window's are kept apart.
 *
 *   npx tsx tests/ui-app-mirror.test.ts
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

const SITE = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{margin:0;font:18px sans-serif} .tall{height:5000px;background:linear-gradient(#fff,#cde)} button{font-size:22px;padding:12px}</style></head>
<body><h1>Scroll me</h1><button id="go" onclick="document.getElementById('out').textContent='clicked'">Press</button><p id="out">waiting</p>
<div class="tall">A long page, so there is somewhere to scroll to.</div></body></html>`;

async function main() {
  if (!fs.existsSync(CHROME)) { console.log("  skip  no browser here"); return; }
  if (!fs.existsSync("dist/index.html")) { console.log("  skip  the app is not built"); return; }
  const app = await startApp();
  const browser = await chromium.launch({ executablePath: CHROME });
  try {
    fs.mkdirSync(`${app.home}/site`, { recursive: true });
    fs.writeFileSync(`${app.home}/site/index.html`, SITE);
    const s = await app.newSession("Scroll", "build");
    app.decide = (req) => req.messages.some((m) => m.role === "tool")
      ? { text: "Open." } : { tools: [{ name: "app_preview", args: { action: "start", dir: "site" } }] };
    await app.turn(s, "build the page", 60_000);
    app.decide = null;
    const api = (method: string, url: string, body?: unknown) => app.api(method, `/api/sessions/${s}/preview${url}`, body);
    /** The real page's scroll, asked of the server's Chrome. */
    const realScroll = async () => (await api("POST", "/rects", { selectors: ["#go"] })).body.scroll.y as number;

    const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page: Page = await ctx.newPage();
    const pictures: number[] = [];
    const mirrors: string[] = [];
    page.on("websocket", (ws) => ws.on("framereceived", (f) => {
      const text = typeof f.payload === "string" ? f.payload : "";
      if (text.startsWith('{"type":"frame"') && text.includes('"source":"preview"')) pictures.push(Date.now());
      if (text.startsWith('{"type":"mirror"')) mirrors.push(text.includes('"source":"preview"') ? "preview" : "browser");
    }));
    await page.goto(`${app.base}/?session=${s}`);

    const copy = () => page.locator(".app-screen .mirror-frame");
    const scrollOf = () => copy().evaluate((f: HTMLIFrameElement) => f.contentDocument?.scrollingElement?.scrollTop ?? -1);

    await test("the page is drawn from its DOM, and the window's pictures stop", async () => {
      await page.waitForSelector(".app-screen .mirror-frame", { timeout: 20_000 });
      await page.waitForFunction(() => {
        const f = document.querySelector(".app-screen .mirror-frame") as HTMLIFrameElement | null;
        return (f?.contentDocument?.body?.innerText ?? "").includes("Scroll me");
      }, null, { timeout: 20_000 });
      await sleep(2500); // the server notices every window is on the copy, and stops its screencast
      const mark = pictures.length;
      await sleep(2500);
      assert.equal(pictures.length - mark, 0, `no pictures while the copy is shown (${pictures.length - mark} arrived)`);
      assert.ok(mirrors.length > 0 && mirrors.every((m) => m === "preview"), "the copy's messages are the window's own");
    });

    await test("a wheel scroll moves the copy at once, and the real page follows", async () => {
      const mark = pictures.length;
      const b = (await page.locator(".app-screen").boundingBox())!;
      await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
      const t0 = Date.now();
      await page.mouse.wheel(0, 600);
      await page.waitForFunction(() => {
        const f = document.querySelector(".app-screen .mirror-frame") as HTMLIFrameElement | null;
        return (f?.contentDocument?.scrollingElement?.scrollTop ?? 0) > 100;
      }, null, { timeout: 3000 });
      const local = Date.now() - t0;
      assert.ok(local < 400, `the copy scrolled by itself, with no server in the way (${local} ms)`);
      const mine = await scrollOf();
      await sleep(1200);
      const real = await realScroll();
      assert.ok(Math.abs(real - mine) < 40, `the real page is where the copy is (${real} vs ${mine})`);
      assert.equal(pictures.length - mark, 0, "scrolling asked for no pictures");
    });

    await test("a click in Use reaches the real page", async () => {
      await page.evaluate(() => (document.querySelector(".app-screen .mirror-frame") as HTMLIFrameElement).contentDocument!.scrollingElement!.scrollTop = 0);
      await sleep(900);
      const btn = await copy().evaluate((f: HTMLIFrameElement) => {
        const r = f.contentDocument!.getElementById("go")!.getBoundingClientRect();
        const fr = f.getBoundingClientRect();
        const k = fr.width / f.offsetWidth;
        return { x: fr.left + (r.left + r.width / 2) * k, y: fr.top + (r.top + r.height / 2) * k };
      });
      await page.mouse.click(btn.x, btn.y);
      await sleep(1200);
      const text = (await api("POST", "/inspect", { selector: "#out" })).body.info.text;
      assert.equal(text, "clicked", "the real page got the click");
    });

    console.log("on a phone");
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    const p: Page = await phone.newPage();
    await p.goto(`${app.base}/?session=${s}`);
    await test("a finger swipe on the page scrolls the copy", async () => {
      await p.waitForSelector(".app-screen .mirror-frame", { timeout: 20_000 });
      await p.waitForFunction(() => {
        const f = document.querySelector(".app-screen .mirror-frame") as HTMLIFrameElement | null;
        return (f?.contentDocument?.body?.innerText ?? "").includes("Scroll me");
      }, null, { timeout: 20_000 });
      await openWorkButtons(p); // the app is a tab in the phone's pinned view: bring it on screen
      await sleep(1200);
      const raw = (await p.locator(".app-screen").boundingBox())!;
      // Only the part of the screen that is on the phone: the gesture must start inside the viewport.
      const top = Math.max(raw.y, 0), bottom = Math.min(raw.y + raw.height, 844), left = Math.max(raw.x, 0), right = Math.min(raw.x + raw.width, 390);
      assert.ok(bottom - top > 100 && right - left > 100, `the page is on screen (${JSON.stringify(raw)})`);
      const where = { x: left, y: top, width: right - left, height: bottom - top };
      const cdp = await phone.newCDPSession(p);
      const before = await p.locator(".app-screen .mirror-frame").evaluate((f: HTMLIFrameElement) => f.contentDocument?.scrollingElement?.scrollTop ?? 0);
      // A finger: down in the middle of the page, dragged up 300 px in small steps, then lifted. Raw touch events, not
      // `Input.synthesizeScrollGesture`, which does not scroll a plain iframe in this Chrome either.
      // The conversation floats over part of the board on a phone: aim at a spot where the page itself is on top.
      const spot = await p.evaluate((r) => {
        for (let fy = 0.5; fy <= 0.95; fy += 0.05) for (const fx of [0.5, 0.3, 0.7]) {
          const px = Math.round(r.x + r.width * fx), py = Math.round(r.y + r.height * (fy > 0.9 ? 0.1 : fy));
          if ((document.elementFromPoint(px, py) as HTMLElement | null)?.classList.contains("mirror-frame")) return { x: px, y: py };
        }
        for (let fy = 0.05; fy < 0.5; fy += 0.05) {
          const px = Math.round(r.x + r.width / 2), py = Math.round(r.y + r.height * fy);
          if ((document.elementFromPoint(px, py) as HTMLElement | null)?.classList.contains("mirror-frame")) return { x: px, y: py };
        }
        return null;
      }, where);
      assert.ok(spot, "some of the page is on top, where a finger can reach it");
      const { x, y } = spot;
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
      for (let i = 1; i <= 12; i++) {
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y - (300 * i) / 12 }] });
        await sleep(16);
      }
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await sleep(600);
      const after = await p.locator(".app-screen .mirror-frame").evaluate((f: HTMLIFrameElement) => f.contentDocument?.scrollingElement?.scrollTop ?? 0);
      assert.ok(after > before + 40, `the swipe scrolled the copy (${before} -> ${after})`);
    });
    console.log(`\n${passed} passed`);
  } finally {
    await browser.close();
    await app.stop();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
