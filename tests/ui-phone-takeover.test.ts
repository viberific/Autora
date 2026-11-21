/**
 * A tool full screen on a phone, and the Creator's pictures. In a real browser, on the built app:
 *
 *   - Full screen on a phone gives the tool the whole screen: nothing of the app's header, the board or the conversation
 *     is over any corner of it, and Autora is a bubble;
 *   - a tap on the bubble opens the conversation over the tool, another puts it away;
 *   - the bubble drags (a quick flick too) and settles on the side it was let go on;
 *   - dropped on the X at the foot of the screen it ends full screen, the window back on the board as it was;
 *   - a Creator page shown as pictures (a canvas falls back to them) never shows the window's white backdrop between two
 *     pictures: each one is decoded before it replaces the last.
 *
 *   npx tsx tests/ui-phone-takeover.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { chromium, type Page } from "playwright-core";
import { sleep, startApp } from "./e2e-harness";
import { CHROME } from "./chrome";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

const SITE = `<!doctype html><html><head><meta name="viewport" content="width=device-width"><style>body{margin:0;background:#2a6;color:#fff;font:24px sans-serif}</style></head><body><h1>My app</h1><button>Press</button></body></html>`;
const CANVAS = `<!doctype html><html><head><style>body{margin:0;background:#123}</style></head><body><canvas id=c width=1280 height=800></canvas>
<script>const x=c.getContext('2d');let t=0;setInterval(()=>{x.fillStyle='hsl('+(t++%360)+',50%,30%)';x.fillRect(0,0,1280,800)},50)</script></body></html>`;

async function main() {
  if (!fs.existsSync(CHROME)) { console.log("  skip  no browser here"); return; }
  if (!fs.existsSync("dist/index.html")) { console.log("  skip  the app is not built"); return; }
  const app = await startApp();
  const browser = await chromium.launch({ executablePath: CHROME });
  try {
    const open = async (html: string, title: string) => {
      const dir = title.toLowerCase();
      fs.mkdirSync(`${app.home}/${dir}`, { recursive: true });
      fs.writeFileSync(`${app.home}/${dir}/index.html`, html);
      const s = await app.newSession(title, "build");
      app.decide = (req) => req.messages.some((m) => m.role === "tool")
        ? { text: "Opened your app in the Creator." } : { tools: [{ name: "app_preview", args: { action: "start", dir } }] };
      await app.turn(s, "build", 60_000);
      app.decide = null;
      return s;
    };

    const s = await open(SITE, "Phone");
    const ctx = await browser.newContext({ viewport: { width: 390, height: 664 }, colorScheme: "dark" });
    const page: Page = await ctx.newPage();
    await page.goto(`${app.base}/?session=${s}`);
    await page.waitForSelector(".app-screen", { timeout: 20_000 });
    await sleep(1500);
    const bubbleAt = () => page.evaluate(() => {
      const r = document.querySelector(".chat-bubble")?.getBoundingClientRect();
      return r ? { x: Math.round(r.x), y: Math.round(r.y) } : null;
    });
    const isOpen = () => page.locator(".chat-view.is-bubble-open").count();

    await test("Full screen gives the tool the phone's whole screen, and Autora is a bubble", async () => {
      await page.locator('.app-window button[aria-label*="ull screen"], .app-window button[title*="ull screen"]').first().click();
      await page.waitForSelector(".pw-engine.is-takeover", { timeout: 5000 });
      await sleep(600);
      const hits = await page.evaluate(() => [[2, 2], [innerWidth - 3, 2], [2, innerHeight - 3], [innerWidth - 3, innerHeight - 3], [innerWidth / 2, innerHeight / 2]]
        .map(([x, y]) => Boolean(document.elementFromPoint(x, y)?.closest(".pw-engine.is-takeover"))));
      assert.deepEqual(hits, [true, true, true, true, true], "the tool is under every corner and the middle");
      assert.ok(await bubbleAt(), "the bubble is there");
    });

    await test("a tap on the bubble opens the conversation over the tool, another puts it away", async () => {
      let b = (await bubbleAt())!;
      await page.mouse.click(b.x + 28, b.y + 28);
      await sleep(500);
      assert.equal(await isOpen(), 1);
      const onTop = await page.evaluate(() => {
        const r = document.querySelector(".conversation-flow")!.getBoundingClientRect();
        return Boolean(document.elementFromPoint(r.x + r.width / 2, r.bottom - 40)?.closest(".conversation-flow"));
      });
      assert.ok(onTop, "the conversation is over the tool");
      b = (await bubbleAt())!;
      await page.mouse.click(b.x + 28, b.y + 28);
      await sleep(500);
      assert.equal(await isOpen(), 0);
    });

    await test("a quick flick drags the bubble, and it settles on the side it was let go on", async () => {
      const b = (await bubbleAt())!;
      await page.mouse.move(b.x + 28, b.y + 28);
      await page.mouse.down();
      await page.mouse.move(80, 200); // one jump, straight off the bubble
      await page.mouse.up();
      await sleep(700);
      const now = (await bubbleAt())!;
      assert.ok(now.x < 40, `on the left (${now.x})`);
      assert.ok(Math.abs(now.y - 172) <= 2, `at the height it was dropped (${now.y})`);
      assert.equal(await isOpen(), 0, "a drag is not a tap");
    });

    await test("dropped on the X at the foot of the screen, it ends full screen", async () => {
      const b = (await bubbleAt())!;
      await page.mouse.move(b.x + 28, b.y + 28);
      await page.mouse.down();
      await page.mouse.move(b.x + 60, b.y + 100);
      await page.mouse.move(195, 664 - 56);
      await sleep(200);
      assert.equal(await page.locator(".chat-bubble-close.is-over").count(), 1, "the X lights up under it");
      await page.mouse.up();
      await sleep(700);
      assert.equal(await page.locator(".chat-bubble").count(), 0);
      assert.equal(await page.locator(".pw-engine.is-takeover, .pw-engine.is-max").count(), 0, "the window is back on the board");
    });
    await ctx.close();

    await test("the Creator's pictures never show its white backdrop between two of them", async () => {
      const c = await open(CANVAS, "Canvas");
      const wide = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: "dark" });
      const p = await wide.newPage();
      await p.goto(`${app.base}/?session=${c}`);
      await p.waitForSelector(".app-screen img.app-frame", { timeout: 30_000 });
      await sleep(2500);
      const screen = p.locator(".app-screen");
      let white = 0;
      let total = 0;
      const start = Date.now();
      while (Date.now() - start < 6000) {
        const png = await screen.screenshot({ animations: "allow" }).catch(() => null);
        if (!png) continue;
        total += 1;
        const share = await p.evaluate(async (b64) => {
          const img = new Image();
          img.src = `data:image/png;base64,${b64}`;
          await img.decode();
          const cv = document.createElement("canvas");
          cv.width = img.width; cv.height = img.height;
          const x = cv.getContext("2d")!;
          x.drawImage(img, 0, 0);
          const d = x.getImageData(0, 0, cv.width, cv.height).data;
          let w = 0;
          for (let i = 0; i < d.length; i += 4 * 97) if (d[i] > 240 && d[i + 1] > 240 && d[i + 2] > 240) w += 1;
          return w / (d.length / (4 * 97));
        }, png.toString("base64"));
        if (share > 0.5) white += 1;
      }
      assert.ok(total >= 10, `enough looks (${total})`);
      assert.equal(white, 0, `${white} of ${total} looks were the white backdrop`);
      await wide.close();
    });
  } finally {
    await browser.close();
    await app.stop();
  }
  console.log(`\n${passed} passed`);
}

main().then(() => process.exit(0), (err) => { console.error(err); process.exit(1); });
