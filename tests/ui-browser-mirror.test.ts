/**
 * The live copy of the browser (MirrorView, server/mirror.ts) in the real built app: with Live copy on, the page the
 * agent opened is drawn from its DOM in a script-free frame; scrolling it is local and asks the server for no
 * pictures (the server's Chrome stops encoding them), and the real page scrolls with it; a click and typing in the copy
 * reach the real page; a canvas is a live picture; nothing the site wrote runs; Picture mode brings the pictures back.
 *
 *   npx tsx tests/ui-browser-mirror.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { chromium, type Frame } from "playwright-core";
import { startApp } from "./e2e-harness";
import { CHROME } from "./chrome";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

const SITE = `<!doctype html><html><head><style>body{margin:0;font:16px sans-serif} .tall{height:4000px}</style></head><body>
<h1 id="hi">Hello mirror</h1>
<input id="name" type="text" oninput="fetch('/typed?v='+encodeURIComponent(this.value))">
<button id="btn" style="font-size:24px;padding:10px" onclick="fetch('/clicked');var p=document.createElement('p');p.id='added';p.textContent='Added by the page';document.body.insertBefore(p,document.querySelector('.tall'))">Press me</button>
<canvas id="cv" width="120" height="60"></canvas>
<img src="nope.png" onerror="window.__pwned=1">
<div class="tall"></div>
<script>var c=document.getElementById('cv').getContext('2d');c.fillStyle='rgb(255,0,0)';c.fillRect(0,0,120,60);
var t=0;addEventListener('scroll',function(){clearTimeout(t);t=setTimeout(function(){fetch('/scrolled?y='+Math.round(scrollY))},120)});</script>
</body></html>`;

async function main() {
  const exe = CHROME;
  if (!fs.existsSync(exe)) { console.log("  skip  no browser here"); return; }
  if (!fs.existsSync("dist/index.html")) { console.log("  skip  the app is not built"); return; }

  const hits: string[] = [];
  const site = http.createServer((req, res) => {
    hits.push(req.url ?? "");
    res.setHeader("content-type", "text/html");
    res.end(req.url === "/" ? SITE : "");
  });
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
  const siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}/`;

  const app = await startApp();
  const browser = await chromium.launch({ executablePath: exe });
  try {
    const s = await app.newSession("Browse", "build");
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
    await ctx.addInitScript(() => { try { localStorage.setItem("autora.browserView", "mirror"); } catch { /* none */ } });
    const page = await ctx.newPage();
    const frames: number[] = [];
    let mirrorMessages = 0;
    page.on("websocket", (ws) => ws.on("framereceived", (f) => {
      const text = typeof f.payload === "string" ? f.payload : "";
      if (text.startsWith('{"type":"frame"')) frames.push(Date.now());
      if (text.startsWith('{"type":"mirror"')) mirrorMessages += 1;
    }));
    const siteRequestsFromViewer: string[] = [];
    page.on("request", (r) => { if (r.url().startsWith(siteUrl)) siteRequestsFromViewer.push(r.url()); });
    await page.goto(`${app.base}/?session=${s}`);
    await page.waitForSelector(".composer", { timeout: 20_000 });
    let n = 0;
    app.decide = (req) => {
      if (/You check one action/.test(req.system)) return { text: '{"destructive": false, "requested": true}' };
      if (req.tools.length === 0) return { text: "SKIP" };
      return n++ === 0 ? { tools: [{ name: "browser_open", args: { url: siteUrl } }] } : { text: "Opened." };
    };
    await app.turn(s, "open my test page", 120_000);

    let copy: Frame | null = null;
    await test("the page is drawn as a live copy of its DOM", async () => {
      const el = await page.waitForSelector(".mirror-wrap:not(.is-hidden) iframe.mirror-frame", { timeout: 30_000 });
      copy = await el.contentFrame();
      assert.ok(copy);
      await copy.waitForSelector("#hi", { timeout: 10_000 });
      assert.equal(await copy.textContent("#hi"), "Hello mirror");
      assert.equal(await el.getAttribute("sandbox"), "allow-same-origin", "never allow-scripts");
      assert.ok(mirrorMessages > 0);
      assert.equal(await page.locator(".shot-stage img.frame:not(.mirror-spacer)").count(), 0, "no picture under it");
    });
    const c = () => copy!;

    await test("nothing the site wrote runs, and the viewer loads nothing from the site", async () => {
      assert.equal(await page.evaluate(() => (window as any).__pwned), undefined);
      assert.equal(await c().evaluate(() => (window as any).__pwned), undefined);
      assert.deepEqual(siteRequestsFromViewer, []);
    });

    await test("scrolling the copy is local, asks for no pictures, and the real page follows", async () => {
      await page.waitForTimeout(1500);
      const box = (await page.locator(".mirror-wrap iframe.mirror-frame").boundingBox())!;
      const since = Date.now();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      for (let i = 0; i < 6; i += 1) { await page.mouse.wheel(0, 200); await page.waitForTimeout(40); }
      const local = await c().evaluate(() => scrollY);
      assert.ok(local >= 600, `the copy scrolled at once: ${local}`);
      await page.waitForTimeout(1200);
      assert.deepEqual(frames.filter((t) => t > since), [], "no pictures were sent while scrolling the copy");
      const scrolled = hits.filter((h) => h.startsWith("/scrolled")).map((h) => Number(h.split("=")[1]));
      assert.ok(scrolled.some((y) => Math.abs(y - local) < 40), `the real page scrolled to the copy's place: ${scrolled} vs ${local}`);
      await c().evaluate(() => scrollTo(0, 0));
      await page.waitForTimeout(500);
    });

    await test("a click in the copy reaches the real page, and its change comes back", async () => {
      await c().click("#btn");
      await c().waitForSelector("#added", { timeout: 10_000 });
      assert.ok(hits.includes("/clicked"), "the real page's own handler ran on the server");
      assert.equal(await c().textContent("#added"), "Added by the page");
      if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
    });

    await test("typing in the copy shows at once and reaches the real page", async () => {
      await c().click("#name");
      await page.keyboard.type("hello", { delay: 30 });
      assert.equal(await c().inputValue("#name"), "hello", "the copy echoes the letters itself");
      const end = Date.now() + 8000;
      while (!hits.includes("/typed?v=hello") && Date.now() < end) await page.waitForTimeout(100);
      assert.ok(hits.includes("/typed?v=hello"), `the real field: ${hits.filter((h) => h.startsWith("/typed")).join(" ")}`);
    });

    await test("a canvas is a live picture in its place", async () => {
      const end = Date.now() + 8000;
      let px: number[] = [0, 0, 0, 0];
      while (Date.now() < end) {
        px = await c().evaluate(() => Array.from((document.querySelector("canvas") as HTMLCanvasElement).getContext("2d")!.getImageData(60, 30, 1, 1).data));
        if (px[0] > 200) break;
        await page.waitForTimeout(200);
      }
      assert.ok(px[0] > 200 && px[1] < 80, `red: ${px}`);
    });

    await test("Picture mode, in the browser's menu, brings the pictures back", async () => {
      await page.getByRole("button", { name: "Browser menu" }).first().click();
      await page.getByRole("menuitemcheckbox", { name: /Picture mode/ }).click();
      await page.waitForSelector(".shot-stage img.frame:not(.mirror-spacer)", { timeout: 15_000 });
      assert.equal(await page.locator(".mirror-wrap").count(), 0);
      const end = Date.now() + 5000;
      while (frames.length === 0 && Date.now() < end) await page.waitForTimeout(100);
      assert.ok(frames.length > 0, "pictures are streaming again");
    });
  } finally {
    await browser.close();
    await app.stop();
    site.close();
  }
  console.log(`\n${passed} passed`);
}

main().catch((err) => { console.error(err); process.exit(1); });
