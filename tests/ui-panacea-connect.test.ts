/**
 * Connecting pieces of work on the board, and the canvas in situations it was not scripted for, in a real browser:
 * a picture's node offers the apps that open pictures, a line dragged from it lights the windows that can take it and
 * dims the ones that cannot, choosing one sends the picture there and says so; and odd input (plain words pasted, a
 * file nothing opens, several things at once beside an open app) leaves the canvas in order.
 *
 *   npx tsx tests/ui-panacea-connect.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import zlib from "node:zlib";
import { chromium, type Page } from "playwright-core";
import { sleep, startApp } from "./e2e-harness";
import { CHROME } from "./chrome";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

function png(w: number, h: number): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) { const i = y * (w * 3 + 1) + 1 + x * 3; raw[i] = 40 + (x % 200); raw[i + 1] = 60 + (y % 150); raw[i + 2] = 140; }
  const chunk = (t: string, d: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0); return Buffer.concat([len, td, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** What is on the board and whether any of it lies on anything else, runs off the board, or sits under the chat. */
const MEASURE = `(() => {
  const b = document.querySelector(".pa-board").getBoundingClientRect();
  const chat = document.querySelector(".conversation-flow")?.getBoundingClientRect();
  const items = Array.from(document.querySelectorAll(".pa-surface, .pa-panel:not(.is-dim), .pw-engine")).map((e) => { const r = e.getBoundingClientRect(); return { n: (e.getAttribute("aria-label") || e.className).slice(0, 40), l: r.left, t: r.top, r: r.right, b: r.bottom }; }).filter((x) => x.r > x.l);
  const hit = (p, q) => p.l < q.r - 6 && p.r > q.l + 6 && p.t < q.b - 6 && p.b > q.t + 6;
  const overlaps = []; for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) if (hit(items[i], items[j])) overlaps.push(items[i].n + " x " + items[j].n);
  return { count: items.length, ghosts: document.querySelectorAll(".pa-panel.is-ghost").length, overlaps,
    off: items.filter((x) => x.l < b.left - 2 || x.r > b.right + 2 || x.t < b.top - 2 || x.b > b.bottom + 2).map((x) => x.n),
    under: chat ? items.filter((x) => hit(x, { l: chat.left, t: chat.top, r: chat.right, b: chat.bottom })).map((x) => x.n) : [] };
})()`;
interface Measure { count: number; ghosts: number; overlaps: string[]; off: string[]; under: string[] }

const drop = (page: Page, files: Array<{ name: string; type: string; b64: string }>, fx = 0.5, fy = 0.4) => page.evaluate(({ files, fx, fy }) => {
  const dt = new DataTransfer();
  for (const f of files) dt.items.add(new File([Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0))], f.name, { type: f.type }));
  const board = document.querySelector(".pa-board")!;
  const r = board.getBoundingClientRect();
  board.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true, clientX: r.left + r.width * fx, clientY: r.top + r.height * fy }));
}, { files, fx, fy });
const paste = (page: Page, text: string) => page.evaluate((text) => {
  const dt = new DataTransfer();
  dt.setData("text/plain", text);
  document.querySelector(".pa-board")!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
}, text);
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

async function main() {
  if (!CHROME || !fs.existsSync(CHROME)) { console.log("  skip  no browser here"); return; }
  if (!fs.existsSync("dist/index.html")) { console.log("  skip  no build (npm run build)"); return; }
  const app = await startApp();
  const browser = await chromium.launch({ executablePath: CHROME });
  const errors: string[] = [];
  try {
    await app.api("PATCH", "/api/agent-cursor", { on: false });
    const open = async (name: string, engines: string[] = []) => {
      const s = await app.newSession(name, "build");
      await app.api("POST", `/api/panacea/${s}/open`);
      for (const e of engines) await app.api("POST", `/api/${e}/${s}/open`);
      const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
      page.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
      // This server has Music only. The board is told Video is here too, so a picture has somewhere it could go.
      await page.route("**/api/settings", async (route) => {
        const res = await route.fetch();
        const body = await res.json() as { tools?: { installed?: Record<string, boolean> } };
        body.tools = { ...body.tools, installed: { ...body.tools?.installed, video: true, photo: false, game: false } };
        await route.fulfill({ response: res, json: body });
      });
      await page.goto(`${app.base}/?session=${s}`);
      await page.waitForSelector(".pa-board");
      await sleep(1200);
      return { s, page };
    };
    const showAll = async (page: Page) => { await page.getByRole("button", { name: "Show all work" }).first().click(); await sleep(900); };

    const { s, page } = await open("Connect", ["studio"]);
    await test("a picture dropped beside an open app lands clear of it, with its controls in order and one offer", async () => {
      await drop(page, [{ name: "sunset.png", type: "image/png", b64: png(320, 200).toString("base64") }]);
      await page.waitForSelector(".pa-surface.is-image canvas");
      await sleep(2500);
      await showAll(page);
      const m = await page.evaluate(MEASURE) as Measure;
      assert.deepEqual(m.overlaps, [], "nothing lies on anything else (the picture is not on Music)");
      assert.deepEqual(m.off, []);
      assert.deepEqual(m.under, [], "and nothing is under the chat");
      assert.equal(m.ghosts, 1);
    });

    const dot = page.locator(".pa-surface.is-image .pa-link-dot");
    await test("the picture has a node; clicking it lists where a picture can go, and Music is not on the list", async () => {
      assert.equal(await dot.count(), 1);
      assert.equal(await page.locator('.pw-engine[data-engine="studio"] .pa-link-dot').count(), 0, "a song has nowhere to go here, so Music has no node");
      await dot.click();
      const menu = page.getByRole("menu", { name: "Send to" });
      await menu.waitFor();
      assert.deepEqual(await menu.getByRole("menuitem").allInnerTexts(), ["Video"], "only apps that open pictures and are on this server");
      await page.keyboard.press("Escape");
      assert.equal(await menu.count(), 0);
    });

    await test("dragging from the node draws a line; a window that cannot take a picture dims, and letting go there sends nothing", async () => {
      const sent: string[] = [];
      page.on("request", (r) => { if (r.method() === "POST" && /\/(load|deliver|flow)(\?|$)/.test(r.url())) sent.push(r.url()); });
      const d = (await dot.boundingBox())!;
      const music = (await page.locator('.pw-engine[data-engine="studio"]').boundingBox())!;
      await page.mouse.move(d.x + d.width / 2, d.y + d.height / 2);
      await page.mouse.down();
      await page.mouse.move(music.x + music.width / 2, music.y + music.height / 2, { steps: 8 });
      await sleep(150);
      assert.equal(await page.locator(".pa-link-line line").count(), 1, "the line follows the pointer");
      assert.equal(await page.locator('.pw-engine[data-engine="studio"]').getAttribute("data-link"), "no");
      await page.mouse.up();
      await sleep(400);
      assert.equal(await page.locator(".pa-link-line").count(), 0);
      assert.deepEqual(sent, []);
    });

    await test("choosing Video keeps the picture as edited, opens it there, notes the line and says so", async () => {
      const calls: Array<{ url: string; body: string }> = [];
      await page.route("**/api/sessions/*/load", async (route) => {
        calls.push({ url: route.request().url(), body: route.request().postData() ?? "" });
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, name: "sunset.png" }) });
      });
      const flow = page.waitForResponse((r) => /\/api\/panacea\/[^/]+\/flow$/.test(r.url()));
      await dot.click();
      await page.getByRole("menu", { name: "Send to" }).getByRole("menuitem", { name: "Video" }).click();
      assert.equal((await flow).status(), 200);
      await page.getByText(/^Sent sunset\.png to Video\.$/).waitFor({ timeout: 5000 });
      assert.equal(calls.length, 1);
      const asked = JSON.parse(calls[0].body) as { app: string; artifact: string };
      assert.equal(asked.app, "video");
      assert.match(asked.artifact, /\S/);
      const doc = (await app.api("GET", `/api/panacea/${s}/doc`)).body as { doc: { flows?: Array<{ from: string; to: string; what: string }> } };
      assert.deepEqual(doc.doc.flows?.map((f) => `${f.from}>${f.to}:${f.what}`), ["panacea>video:sunset.png"]);
    });
    await page.close();

    const odd = (await open("Odd")).page;
    await test("plain words pasted on the canvas become a page; rows become a table", async () => {
      await paste(odd, "only\none\ncolumn\nhere");
      await odd.waitForSelector(".pa-surface.is-doc .ProseMirror");
      assert.match(await odd.locator(".pa-surface.is-doc .ProseMirror").innerText(), /only[\s\S]*here/);
      await paste(odd, "Name\tScore\nÅsa 😀\t12\nBjörn\t7");
      await odd.waitForSelector(".pa-surface.is-data");
      assert.match(await odd.locator(".pa-surface.is-data").innerText(), /Åsa 😀/);
    });
    await test("four files dropped at once: three land in order with one offer, and the one nothing opens is said plainly", async () => {
      await drop(odd, [
        { name: "a.png", type: "image/png", b64: png(200, 300).toString("base64") },
        { name: "sales.csv", type: "text/csv", b64: b64("month,amount\nJan,10\nFeb,14\nMar,9") },
        { name: "notes.md", type: "text/markdown", b64: b64("# Notes\n\nSome words.") },
        { name: "archive.zip", type: "application/zip", b64: b64("PK not really") },
      ]);
      await odd.getByText(/nothing that opens archive\.zip/).waitFor({ timeout: 15_000 });
      assert.equal(await odd.getByText(/not-supported/).count(), 0, "no code shown to the person");
      await sleep(3500);
      await showAll(odd);
      const m = await odd.evaluate(MEASURE) as Measure;
      assert.ok(m.count >= 5, JSON.stringify(m));
      assert.deepEqual(m.overlaps, []);
      assert.deepEqual(m.off, []);
      assert.equal(m.ghosts, 1, "one offer at a time, however much arrived");
    });
    await test("Tidy keeps each piece of work with its controls, in view and clear of the chat", async () => {
      await odd.getByRole("button", { name: "Tidy the layout" }).click();
      await sleep(1500);
      const m = await odd.evaluate(MEASURE) as Measure;
      assert.deepEqual(m.overlaps, []);
      assert.deepEqual(m.under, []);
    });
    await odd.close();
    assert.deepEqual(errors, [], "no page errors");
  } finally { await browser.close(); await app.stop(); }
  console.log(`\n${passed} ui-panacea-connect tests passed`);
}
main().catch((e) => { console.error(e); process.exit(1); });
