/**
 * App windows on the board in a real browser (docs/PANACEA-GAPS.md, G2): they are kept with the canvas (a drag survives a
 * reload), a click raises one over the rest, the agent lays them out with panacea_arrange, Tidy puts them in rows with none
 * over another, and on a phone a maximised window stays clear of the board's own bottom row.
 *
 * Needs a build (npm run build, with autora-3d) and a browser (AUTORA_BROWSER_PATH=/opt/pw-browsers/chromium-1243/chrome-linux64/chrome).
 *
 *   npx tsx tests/ui-panacea-windows.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { chromium, type Browser, type Page } from "playwright-core";
import type { Canvas } from "../src/lib/panacea/canvas";
import { sleep, startApp } from "./e2e-harness";
import { CHROME } from "./chrome";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

async function main() {
  const exe = CHROME;
  if (!exe || !fs.existsSync(exe)) { console.log("  skip  no browser here"); return; }
  if (!fs.existsSync("dist/index.html") || !fs.existsSync("dist/autora-3d-engine/engine.mjs")) { console.log("  skip  the page or the 3D modeller is not built (npm run build)"); return; }
  const app = await startApp();
  const browser: Browser = await chromium.launch({ executablePath: exe });
  const errors: string[] = [];
  try {
    await app.api("PATCH", "/api/agent-cursor", { on: false });
    const until = async (what: string, fn: () => Promise<boolean> | boolean, ms = 15_000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) { if (await fn()) return; await sleep(100); }
      throw new Error(`timed out: ${what}`);
    };
    const doc = async (s: string) => ((await app.api("GET", `/api/panacea/${s}/doc`)).body as { doc: Canvas }).doc;
    const wins = async (s: string) => (await doc(s)).windows ?? [];
    const rects = (page: Page) => page.evaluate(`(() => Object.fromEntries(Array.from(document.querySelectorAll(".pw-engine")).map((e) => { const r = e.getBoundingClientRect(); return [e.getAttribute("data-work"), { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), left: e.style.left, top: e.style.top, width: e.style.width, z: e.style.zIndex }]; })))()`) as Promise<Record<string, { x: number; y: number; w: number; h: number; left: string; top: string; width: string; z: string }>>;

    const s = await app.newSession("Windows", "build");
    for (const a of ["studio", "cad"]) assert.equal((await app.api("POST", `/api/${a}/${s}/open`)).status, 200);
    const page: Page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${app.base}/?session=${s}`);
    await page.waitForSelector('.pw-engine[data-work="engine:studio"]');
    await page.waitForSelector('.pw-engine[data-work="engine:cad"]');

    await test("each window's place is written to the canvas when it opens, and the room the page has for work with it", async () => {
      await until("both windows are in the canvas", async () => (await wins(s)).length === 2);
      const c = await doc(s);
      assert.deepEqual(c.windows!.map((w) => w.id).sort(), ["engine:cad", "engine:studio"]);
      assert.ok(c.room && c.room.w > 400 && c.room.h > 300, `the room is measured: ${JSON.stringify(c.room)}`);
    });

    await test("a window dragged by its title bar stays where it was put, through a reload", async () => {
      const before = (await rects(page))["engine:studio"]!;
      // One strip: the app's own bar, with the file's name, is the window's title bar (the board's buttons sit at its right end).
      const head = page.locator('.pw-engine[data-work="engine:studio"] .pw-engine-body .pdf-bar');
      const box = (await head.boundingBox())!;
      await page.mouse.move(box.x + 120, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + 120 + 160, box.y + box.height / 2 + 96, { steps: 10 });
      await page.mouse.up();
      // The board may be zoomed out, so how far it went in the world is what the drag was divided by the zoom: only that it went right and down.
      await until("the canvas has the new place", async () => { const w = (await wins(s)).find((x) => x.id === "engine:studio")!; return w.x > Number.parseFloat(before.left) + 50 && w.y > Number.parseFloat(before.top) + 30; });
      const moved = (await rects(page))["engine:studio"]!;
      assert.notEqual(moved.left, before.left);
      await page.reload();
      await page.waitForSelector('.pw-engine[data-work="engine:studio"]');
      await sleep(800);
      const after = (await rects(page))["engine:studio"]!;
      assert.deepEqual([after.left, after.top, after.width], [moved.left, moved.top, moved.width], "the same place, after a reload");
    });

    await test("a click on a window raises it over the other", async () => {
      const z = async (id: string) => (await wins(s)).find((w) => w.id === id)!.z;
      const cadFront = (await z("engine:cad")) > (await z("engine:studio"));
      const target = cadFront ? "engine:studio" : "engine:cad";
      await page.locator(`.pw-engine[data-work="${target}"] .pw-engine-body .pdf-bar`).click({ position: { x: 150, y: 10 } });
      await until("the clicked window is in front in the canvas", async () => (await z(target)) > (await z(target === "engine:cad" ? "engine:studio" : "engine:cad")));
      const r = await rects(page);
      assert.ok(Number(r[target]!.z) > Number(r[target === "engine:cad" ? "engine:studio" : "engine:cad"]!.z), "and on the page");
    });

    await test("the agent moves a window with panacea_arrange, and the page follows", async () => {
      let done = false;
      app.decide = (req) => {
        if (/You check one action/.test(req.system)) return { text: '{"destructive": false, "requested": true}' };
        if (done) return { text: "Moved." };
        done = true;
        return { tools: [{ name: "panacea_arrange", args: { windows: [{ window: "3D", x: 2400, y: 160, w: 640, h: 480 }] } }] };
      };
      const events = await app.turn(s, "put the 3D window to the right", 90_000);
      assert.deepEqual(events.filter((e) => e.kind === "tool.error").map((e) => e.payload.error), [], "no tool failed");
      await until("the 3D window is where it was told", async () => { const r = (await rects(page))["engine:cad"]!; return r.left === "2400px" && r.top === "160px" && r.width === "640px"; });
    });

    await test("Tidy puts the windows in rows with none over another, and the canvas keeps it", async () => {
      await page.locator('button[aria-label="Tidy the layout"]').click();
      await until("no window is over another", async () => { const r = Object.values(await rects(page)); return r.length === 2 && !(r[0]!.x < r[1]!.x + r[1]!.w && r[1]!.x < r[0]!.x + r[0]!.w && r[0]!.y < r[1]!.y + r[1]!.h && r[1]!.y < r[0]!.y + r[0]!.h); });
      const saved = await wins(s);
      const [a, b] = saved;
      assert.ok(!(a!.x < b!.x + b!.w && b!.x < a!.x + a!.w && a!.y < b!.y + b!.h && b!.y < a!.y + a!.h), "the canvas has them apart too");
    });

    await test("maximise fills the room, is kept through a reload, and restore gives the window back", async () => {
      const was = (await wins(s)).find((w) => w.id === "engine:studio")!;
      await page.locator('button[aria-label="Maximise Music"]').click();
      await until("the canvas says it is maximised", async () => Boolean((await wins(s)).find((w) => w.id === "engine:studio")!.was));
      const room = (await doc(s)).room!;
      const m = (await wins(s)).find((w) => w.id === "engine:studio")!;
      assert.ok(Math.abs(m.w - (room.w - 32)) <= 20, `as wide as the room (${m.w} of ${room.w})`);
      assert.deepEqual([m.was!.w, m.was!.h], [was.w, was.h]);
      await page.reload();
      await page.waitForSelector('button[aria-label="Restore Music"]');
      await page.locator('button[aria-label="Restore Music"]').click();
      await until("the window is as it was", async () => { const w = (await wins(s)).find((x) => x.id === "engine:studio")!; return !w.was && w.w === was.w && w.h === was.h; });
    });
    await test("with Visible work on, the agent lays a window out by hand: its title bar is dragged and its corner sized", async () => {
      await app.api("PATCH", "/api/agent-cursor", { on: true });
      const page2 = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
      page2.on("pageerror", (e) => errors.push(e.message));
      await page2.goto(`${app.base}/?session=${s}`);
      await page2.waitForSelector('.pw-engine[data-work="engine:cad"]');
      await sleep(2500);
      const now = (await wins(s)).find((w) => w.id === "engine:cad")!;
      const target = { x: now.x + 320, y: now.y + 160, w: now.w + 160, h: now.h };
      let done = false;
      app.decide = (req) => {
        if (/You check one action/.test(req.system)) return { text: '{"destructive": false, "requested": true}' };
        if (done) return { text: "Moved." };
        done = true;
        return { tools: [{ name: "panacea_arrange", args: { windows: [{ window: "3D", ...target }] } }] };
      };
      app.seen.length = 0;
      const events = await app.turn(s, "move the 3D window and make it wider", 150_000);
      assert.deepEqual(events.filter((e) => e.kind === "tool.error").map((e) => e.payload.error), [], "no tool failed");
      const said = app.seen.map((r) => JSON.stringify(r.messages.filter((m) => m.role === "tool"))).join("\n");
      assert.match(said, /Done by hand in the Panacea window, where the person watched: moved 3D; sized 3D/, "the hand did both");
      await until("the canvas has the window where it was told", async () => { const w = (await wins(s)).find((x) => x.id === "engine:cad")!; return Math.abs(w.x - target.x) <= 16 && Math.abs(w.y - target.y) <= 16 && Math.abs(w.w - target.w) <= 16; });
      await page2.context().close();
      await app.api("PATCH", "/api/agent-cursor", { on: false });
    });
    await page.context().close();

    await test("on a phone a maximised window stays clear of the board's bottom row and its buttons", async () => {
      const p = await app.newSession("Windows phone", "build");
      for (const a of ["studio", "cad"]) assert.equal((await app.api("POST", `/api/${a}/${p}/open`)).status, 200);
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
      const phone = await ctx.newPage();
      phone.on("pageerror", (e) => errors.push(e.message));
      await phone.goto(`${app.base}/?session=${p}`);
      await phone.waitForSelector('.pw-engine[data-work="engine:studio"]');
      await until("the window's place is written", async () => (await wins(p)).length === 2);
      await phone.locator('button[aria-label="Maximise Music"]').first().dispatchEvent("click");
      await until("it is maximised", async () => Boolean((await wins(p)).find((w) => w.id === "engine:studio")?.was));
      await sleep(900);
      const clear = await phone.evaluate(`(() => {
        const e = document.querySelector('.pw-engine[data-work="engine:studio"]').getBoundingClientRect();
        const bottoms = Array.from(document.querySelectorAll(".pa-dock > *")).map((d) => d.getBoundingClientRect()).filter((r) => r.height > 0);
        const nav = document.querySelector(".conversation-flow__work-navigation");
        const n = nav && nav.getBoundingClientRect();
        return JSON.stringify({ bottom: e.bottom, right: e.right, left: e.left, dockTop: bottoms.length ? Math.min(...bottoms.map((r) => r.top)) : null, navLeft: n && n.width > 0 ? n.left : null });
      })()`) as string;
      const c = JSON.parse(clear) as { bottom: number; right: number; left: number; dockTop: number | null; navLeft: number | null };
      assert.ok(c.dockTop !== null, "the board's bottom row is there");
      assert.ok(c.bottom <= c.dockTop! + 1, `the window ends (${c.bottom}) above the history slider (${c.dockTop})`);
      if (c.navLeft !== null) assert.ok(c.right <= c.navLeft + 1, `and left of the buttons (${c.right} vs ${c.navLeft})`);
      await ctx.close();
    });
    assert.deepEqual(errors, [], "no page errors");
  } finally { await browser.close(); await app.stop(); }
  console.log(`\n${passed} ui-panacea-windows tests passed`);
}
main().catch((e) => { console.error(e); process.exit(1); });
