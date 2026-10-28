/**
 * Panacea as a person uses it, in a real browser: a blank canvas beside the chat; a table pasted and a photo dropped
 * bring their panels with them; a filter chip filters the chart; the picker summons a piece; a slider moves the
 * picture; a panel put away comes back; the history undoes; and the agent's panels arrive live, by its hand when
 * Visible work is on.
 *
 *   npx tsx tests/ui-panacea.test.ts          (PANACEA_SHOTS=<dir> keeps screenshots)
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import zlib from "node:zlib";
import { chromium, type Page } from "playwright-core";
import { sleep, startApp } from "./e2e-harness";

let passed = 0;
let onFail: () => Promise<void> = async () => undefined;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); await onFail().catch(() => undefined); throw err; }
}

/** A PNG of a soft gradient with a bright patch, made here so the test needs no file. */
function png(w: number, h: number): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const i = y * (w * 3 + 1) + 1 + x * 3;
      const sun = Math.hypot(x - w * 0.7, y - h * 0.3) < h * 0.15;
      raw[i] = sun ? 250 : 40 + Math.round((x / w) * 120);
      raw[i + 1] = sun ? 230 : 60 + Math.round((y / h) * 90);
      raw[i + 2] = sun ? 180 : 110;
    }
  }
  const crc = (b: Buffer) => { let c = ~0; for (const v of b) { c ^= v; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (type: string, data: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const CSV = "Month\tRegion\tRevenue\tUnits\n2024-01\tEU\t120\t5\n2024-01\tUS\t200\t8\n2024-02\tEU\t150\t6\n2024-02\tUS\t180\t7\n2024-03\tEU\t170\t6\n2024-03\tUS\t260\t9\n2024-03\tAPAC\t90\t3\n";

async function main() {
  const exe = process.env.AUTORA_BROWSER_PATH || ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome", "/opt/pw-browsers/chromium"].find((p) => fs.existsSync(p));
  if (!exe || !fs.existsSync(exe)) { console.log("  skip  no browser here"); return; }
  if (!fs.existsSync("dist/index.html")) { console.log("  skip  no build (npm run build)"); return; }
  const shots = process.env.PANACEA_SHOTS || "";
  const app = await startApp();
  const browser = await chromium.launch({ executablePath: exe, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const errors: string[] = [];
  const page: Page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  const shot = async (name: string) => { if (shots) await page.screenshot({ path: `${shots}/${name}.png` }); };
  onFail = () => shot("failed");
  try {
    await app.api("PATCH", "/api/agent-cursor", { on: false });
    const s = await app.newSession("Canvas", "build");
    await page.goto(`${app.base}/?session=${s}`);
    await page.waitForSelector('textarea[aria-label="Task"]');
    const doc = async () => (await app.api("GET", `/api/panacea/${s}/doc`)).body.doc;
    /** What the tools answered the model, from what it was sent. */
    const toolResults = () => app.seen.flatMap((req) => req.messages.filter((m) => m.role === "tool").map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))));
    const until = async (what: string, fn: () => Promise<boolean> | boolean, ms = 8000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) { if (await fn()) return; await sleep(100); }
      throw new Error(`timed out: ${what}`);
    };

    await test("opening it puts a blank dotted canvas beside the chat that asks what you want to do", async () => {
      assert.equal((await app.api("POST", `/api/panacea/${s}/open`)).status, 200);
      await page.waitForSelector('[data-pane="panacea"] .pa-window');
      await page.waitForSelector(".pa-empty");
      assert.match(await page.locator(".pa-empty h3").innerText(), /What do you want to do/);
      assert.equal(await page.locator(".pa-panel").count(), 0, "nothing on it until the work needs it");
      await shot("1-empty");
    });

    await test("a pasted table becomes a surface, with a chart and a category filter beside it and Explore offered", async () => {
      await page.locator(".pa-board").click({ position: { x: 300, y: 200 } });
      await page.evaluate((text) => {
        const dt = new DataTransfer();
        dt.setData("text/plain", text);
        document.querySelector(".pa-board")!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
      }, CSV);
      await page.waitForSelector(".pa-surface.is-data");
      await page.waitForSelector(".pa-panel svg.pa-chart");
      await until("the server has it", async () => (await doc()).surfaces.length === 1);
      const d = await doc();
      assert.deepEqual(d.surfaces[0].table.columns.map((c: { type: string }) => c.type), ["date", "text", "number", "number"]);
      const recipes = d.panels.map((p: { recipe: string }) => p.recipe).sort();
      assert.ok(recipes.includes("data.line") && recipes.includes("data.filter-category"), recipes.join(","));
      assert.ok(d.panels.some((p: { state: string }) => p.state === "ghost"), "one more is offered as a ghost");
      assert.equal(await page.locator(".pa-empty").count(), 0);
      await shot("2-table");
    });

    await test("a chip in the category filter filters the chart and the table, live, and is saved", async () => {
      const rowsBefore = await page.locator(".pa-surface.is-data tbody tr").count();
      await page.click('.pa-panel [data-atom="chips"] button[data-value="EU"]');
      await until("fewer rows", async () => (await page.locator(".pa-surface.is-data tbody tr").count()) < rowsBefore);
      assert.equal(await page.locator(".pa-surface.is-data tbody tr").count(), 3);
      await until("the server has the filter", async () => JSON.stringify((await doc()).surfaces[0].params["filter.Region"]) === '["EU"]');
    });

    await test("Add takes a ghost; filtering to one category then offers its top rows, and Not now waves it away", async () => {
      await page.locator(".pa-panel.is-ghost:has(.pa-title:text-is('Explore'))").locator('[data-act="accept"]').click();
      await until("Explore is live on the server", async () => (await doc()).panels.some((p: { recipe: string; state: string }) => p.recipe === "data.explore" && p.state === "live"));
      // Explore charts Revenue by Region: the measure, not a count of rows.
      assert.equal(await page.locator(".pa-panel:has(.pa-title:text-is('Explore')) rect.pa-bar").count(), 1, "one bar: EU, as filtered");
      await page.click('.pa-panel [data-atom="chips"] button[data-value="US"]');
      await sleep(300);
      await page.click('.pa-panel [data-atom="chips"] button[data-value="EU"]');
      await page.waitForSelector(".pa-panel.is-ghost:has(.pa-title:text-is('Top rows'))");
      await page.locator(".pa-panel.is-ghost:has(.pa-title:text-is('Top rows'))").locator('[data-act="wave"]').click();
      await until("no ghost on the server", async () => !(await doc()).panels.some((p: { state: string }) => p.state === "ghost"));
      assert.ok(!(await doc()).panels.some((p: { recipe: string }) => p.recipe === "data.top"));
      await until("the wave is learned", async () => ((await app.api("GET", "/api/panacea/profile")).body.profile.dismissed["data.top"] ?? 0) === 1);
      await sleep(2500);
      const back = (await doc()).panels.filter((p: { state: string }) => p.state === "ghost");
      assert.ok(!back.length, `and it stays away: ${JSON.stringify(back.map((p: { title: string; why: string; by: string }) => [p.title, p.why, p.by]))}`);
    });

    await test("double-click the grid, type, pick: a piece lands there, and its slider sets a value of its own", async () => {
      const box = (await page.locator(".pa-board").boundingBox())!;
      await page.mouse.dblclick(box.x + 120, box.y + box.height - 220);
      await page.waitForSelector(".pa-summon-q");
      await page.fill(".pa-summon-q", "slider");
      await page.keyboard.press("Enter");
      await page.waitForSelector('.pa-panel [data-atom="slider"][data-bind="value"]');
      const track = page.locator('.pa-panel [data-bind="value"] .pa-track');
      const tb = (await track.boundingBox())!;
      await page.mouse.click(tb.x + tb.width * 0.75, tb.y + tb.height / 2);
      await until("the value is set", async () => Math.abs(Number((await doc()).values.value) - 75) <= 2);
    });

    let photoId = "";
    await test("a dropped photo becomes a surface with Light and Colour beside it and the looks offered", async () => {
      const data = png(320, 200).toString("base64");
      await page.evaluate(async (b64) => {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const dt = new DataTransfer();
        dt.items.add(new File([bytes], "sunset.png", { type: "image/png" }));
        const board = document.querySelector(".pa-board")!;
        const r = board.getBoundingClientRect();
        board.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true, clientX: r.left + r.width * 0.6, clientY: r.top + 240 }));
      }, data);
      await page.waitForSelector(".pa-surface.is-image canvas");
      await until("the server has two surfaces", async () => (await doc()).surfaces.length === 2);
      const d = await doc();
      photoId = d.surfaces.find((x: { kind: string }) => x.kind === "image").id;
      assert.ok(d.panels.some((p: { recipe: string; context: string }) => p.recipe === "photo.light" && p.context === photoId));
      assert.ok(d.panels.some((p: { recipe: string; context: string }) => p.recipe === "photo.colour" && p.context === photoId));
      assert.equal(d.focus, photoId, "the work is on the photo now");
      assert.ok(d.panels.some((p: { state: string }) => p.state === "dim"), "the table's panels dimmed when the work moved on");
      await page.waitForSelector(".pa-surface-meta:has-text('320 × 200')");
      await shot("3-photo");
    });

    await test("Exposure moves the picture, live on the GPU, and the histogram follows", async () => {
      const pixel = () => page.evaluate(() => {
        const c = document.querySelector<HTMLCanvasElement>(".pa-surface.is-image canvas")!;
        const tmp = document.createElement("canvas");
        tmp.width = c.width; tmp.height = c.height;
        const g = tmp.getContext("2d")!;
        g.drawImage(c, 0, 0);
        const d = g.getImageData(Math.floor(c.width * 0.2), Math.floor(c.height * 0.8), 1, 1).data;
        return d[0]! + d[1]! + d[2]!;
      });
      await until("drawn", async () => (await pixel()) > 0, 6000);
      const before = await pixel();
      const track = page.locator(`.pa-panel [data-bind="@${photoId}.exposure"] .pa-track`);
      const tb = (await track.boundingBox())!;
      await page.mouse.click(tb.x + tb.width * 0.85, tb.y + tb.height / 2);
      await until("the server has it", async () => Number((await doc()).surfaces.find((x: { id: string }) => x.id === photoId).params.exposure) > 1);
      await until("brighter", async () => (await pixel()) > before + 30, 4000);
      await page.keyboard.press("Escape");
      await page.locator(".pa-board").press("/");
      await page.fill(".pa-summon-q", "histogram");
      await page.click('.pa-summon [data-recipe="photo.histogram"]');
      await page.waitForFunction(() => document.querySelector(".pa-panel .pa-hist svg path") !== null);
      await page.waitForSelector(".pa-hist-warn:has-text('Highlights clipping')");
    });

    await test("a panel put away waits in the corner and comes back with a click", async () => {
      const light = page.locator(".pa-panel:has(.pa-title:text-is('Light'))");
      await light.hover();
      await light.locator('[data-act="close"]').click();
      await page.waitForSelector(".pa-gone-btn");
      assert.equal(await light.count(), 0);
      await page.click(".pa-gone-btn");
      await page.click(".pa-gone-list button:has-text('Light')");
      await page.waitForSelector(".pa-panel:has(.pa-title:text-is('Light'))");
      assert.equal(await page.evaluate(() => document.querySelector(".pa-board")!.scrollTop), 0, "the canvas never scrolls out from under its chrome");
    });

    await test("the history undoes a step and the track scrubs", async () => {
      const exp = async () => Number((await doc()).surfaces.find((x: { id: string }) => x.id === photoId).params.exposure);
      const was = await exp();
      for (let i = 0; i < 10 && (await exp()) === was; i++) { await page.click('.pa-history [aria-label="Undo"]'); await sleep(450); }
      await until("exposure undone", async () => (await exp()) !== was);
      // The end of the track is now: back to it, and the exposure is back.
      const t = (await page.locator(".pa-htrack").boundingBox())!;
      await page.mouse.click(t.x + t.width - 1, t.y + t.height / 2);
      await until("redone by the track", async () => (await exp()) === was);
    });

    await test("the agent's panels arrive live; a tree outside the rulebook is refused with the reason", async () => {
      app.script = [
        { tools: [{ name: "panacea_place", args: { title: "Mood", why: "To see how it feels.", tree: { atom: "stack", children: [{ atom: "wobble", bind: "x" }] } } }] },
        { tools: [{ name: "panacea_place", args: { title: "Plan", why: "To plan the shoot.", tree: { atom: "stack", children: [{ atom: "segmented", bind: "shoot.when", props: { label: "When", options: ["Dawn", "Noon", "Dusk"] } }, { atom: "toggle", bind: "shoot.tripod", props: { label: "Tripod" } }] } } }] },
        { text: "Done." },
      ];
      await app.turn(s, "Help me plan the shoot on the canvas.");
      const results = toolResults();
      assert.ok(results.some((r) => /"wobble" is not an atom/.test(r)), results.join(" | "));
      await page.waitForSelector('.pa-panel [data-bind="shoot.when"]');
      await page.click('.pa-panel [data-bind="shoot.when"] button[data-value="Dusk"]');
      await until("set", async () => (await doc()).values["shoot.when"] === "Dusk");
      await shot("4-agent");
    });

    await test("with Visible work on, the agent's panacea_set is done by its hand on the person's own slider", async () => {
      await app.api("PATCH", "/api/agent-cursor", { on: true });
      app.script = [{ tools: [{ name: "panacea_set", args: { values: { [`@${photoId}.contrast`]: 40 } } }] }, { text: "Set." }];
      await app.turn(s, "More contrast please.", 60_000);
      const result = toolResults().join(" ");
      assert.match(result, /Done by hand in the Panacea window/);
      assert.equal(Number((await doc()).surfaces.find((x: { id: string }) => x.id === photoId).params.contrast), 40);
      await app.api("PATCH", "/api/agent-cursor", { on: false });
    });

    await test("nothing went wrong in the page", async () => {
      assert.deepEqual(errors, []);
    });
  } finally {
    await browser.close();
    await app.stop();
  }
  console.log(`\n${passed} passed`);
}

main().then(() => process.exit(0), (err) => { console.error(err); process.exit(1); });
