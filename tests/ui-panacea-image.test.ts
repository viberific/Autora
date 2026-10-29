/**
 * Panacea's image engine as a person uses it, in a real browser: a photo arrives with its Tools beside it; a box dragged
 * on it is a selection (marching ants, and the Selection panel comes); Adjust keeps it with sliders of its own that
 * light only that part; the wand and Copy to layer lift the sun onto a layer the Move tool drags; the brush paints; text
 * goes where it is clicked; Remove fills a thing in from around it; the crop tool crops; the model selects an object
 * from a click; and the agent's panacea_do and panacea_look work the same engine, by hand when Visible work is on.
 *
 *   npx tsx tests/ui-panacea-image.test.ts          (PANACEA_SHOTS=<dir> keeps screenshots)
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

/** 400x300: a blue sky above a green field, and a bright yellow sun in the sky at (0.7, 0.3). */
function png(w: number, h: number): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const i = y * (w * 3 + 1) + 1 + x * 3;
      const sun = Math.hypot(x - w * 0.7, y - h * 0.3) < h * 0.12;
      const sky = y < h * 0.55;
      const [r, g, b] = sun ? [250, 220, 40] : sky ? [70, 120, 200] : [50, 140, 60];
      raw[i] = r; raw[i + 1] = g; raw[i + 2] = b;
    }
  }
  const crc = (b: Buffer) => { let c = ~0; for (const v of b) { c ^= v; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (type: string, data: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

async function main() {
  const exe = process.env.AUTORA_BROWSER_PATH || ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome", "/opt/pw-browsers/chromium"].find((p) => fs.existsSync(p));
  if (!exe || !fs.existsSync(exe)) { console.log("  skip  no browser here"); return; }
  if (!fs.existsSync("dist/index.html")) { console.log("  skip  no build (npm run build)"); return; }
  const shots = process.env.PANACEA_SHOTS || "";
  const app = await startApp();
  const browser = await chromium.launch({ executablePath: exe, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const errors: string[] = [];
  const page: Page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|object model|TensorFlow Lite/.test(m.text())) errors.push(m.text()); });
  const shot = async (name: string) => { if (shots) await page.screenshot({ path: `${shots}/img-${name}.png` }); };
  onFail = () => shot("failed");
  try {
    await app.api("PATCH", "/api/agent-cursor", { on: false });
    const s = await app.newSession("Photo", "build");
    await page.goto(`${app.base}/?session=${s}`);
    await page.waitForSelector('textarea[aria-label="Task"]');
    const doc = async () => (await app.api("GET", `/api/panacea/${s}/doc`)).body.doc;
    const photo = async () => (await doc()).surfaces.find((x: { kind: string }) => x.kind === "image");
    const toolResults = () => app.seen.flatMap((req) => req.messages.filter((m) => m.role === "tool").map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))));
    const until = async (what: string, fn: () => Promise<boolean> | boolean, ms = 8000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) { if (await fn()) return; await sleep(100); }
      throw new Error(`timed out: ${what}`);
    };
    /** The picture as drawn, at a point (0..1 across what is shown): r + g + b, and each. */
    const pixel = (x: number, y: number) => page.evaluate(([px, py]) => {
      const c = document.querySelector<HTMLCanvasElement>(".pa-surface.is-image .pa-image-gl")!;
      const tmp = document.createElement("canvas");
      tmp.width = c.width; tmp.height = c.height;
      const g = tmp.getContext("2d")!;
      g.drawImage(c, 0, 0);
      const d = g.getImageData(Math.floor(c.width * px!), Math.floor(c.height * py!), 1, 1).data;
      return { sum: d[0]! + d[1]! + d[2]!, r: d[0]!, g: d[1]!, b: d[2]! };
    }, [x, y]);
    /** Pan the canvas so the picture is in view, as a person drags the grid: new panels may have taken the view to them. */
    const reveal = async () => {
      const move = await page.evaluate(() => {
        const board = document.querySelector(".pa-board")!.getBoundingClientRect();
        const pic = document.querySelector(".pa-surface.is-image")!.getBoundingClientRect();
        if (pic.top >= board.top + 40 && pic.bottom <= board.bottom - 80 && pic.left >= board.left && pic.right <= board.right) return null;
        // An empty spot of the grid to drag.
        for (let y = board.top + 60; y < board.bottom - 100; y += 20) for (let x = board.left + 20; x < board.right - 20; x += 20) {
          if (document.elementFromPoint(x, y)?.classList.contains("pa-board")) return { x, y, dx: board.left + board.width / 2 - (pic.left + pic.width / 2), dy: board.top + 80 - pic.top };
        }
        return null;
      });
      if (!move) return;
      await page.mouse.move(move.x, move.y);
      await page.mouse.down();
      await page.mouse.move(move.x + move.dx, move.y + move.dy, { steps: 8 });
      await page.mouse.up();
    };
    /** A screen point on the picture, 0..1 across what is shown. */
    const at = async (x: number, y: number) => {
      await reveal();
      const b = (await page.locator(".pa-surface.is-image .pa-image-tools").boundingBox())!;
      return { x: b.x + b.width * x, y: b.y + b.height * y };
    };
    const dragOn = async (pts: Array<[number, number]>, mods: string[] = []) => {
      for (const m of mods) await page.keyboard.down(m);
      const first = await at(pts[0]![0], pts[0]![1]);
      await page.mouse.move(first.x, first.y);
      await page.mouse.down();
      for (const [x, y] of pts.slice(1)) { const p = await at(x, y); await page.mouse.move(p.x, p.y, { steps: 6 }); }
      await page.mouse.up();
      for (const m of mods) await page.keyboard.up(m);
    };
    const key = async (k: string) => { await page.locator(".pa-window").focus(); await page.keyboard.press(k); };
    let id = "";

    await test("a photo arrives with its Tools beside it, on the other side from Light and Colour", async () => {
      assert.equal((await app.api("POST", `/api/panacea/${s}/open`)).status, 200);
      await page.waitForSelector(".pa-empty");
      const data = png(400, 300).toString("base64");
      await page.evaluate(async (b64) => {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const dt = new DataTransfer();
        dt.items.add(new File([bytes], "sky.png", { type: "image/png" }));
        const board = document.querySelector(".pa-board")!;
        const r = board.getBoundingClientRect();
        board.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true, clientX: r.left + r.width * 0.45, clientY: r.top + 260 }));
      }, data);
      await page.waitForSelector('.pa-panel [data-atom="tools"]');
      await until("drawn", async () => (await pixel(0.1, 0.1)).sum > 0, 8000);
      id = (await photo()).id;
      const tools = (await page.locator('.pa-panel:has([data-atom="tools"])').boundingBox())!;
      const pic = (await page.locator(".pa-surface.is-image").boundingBox())!;
      assert.ok(tools.x + tools.width <= pic.x + 2, "the tools are left of the picture");
      assert.equal(await page.locator('.pa-panel [data-atom="tools"] button').count(), 16, "every tool");
      await shot("1-photo");
    });

    await test("a box dragged with the Rectangle tool is a selection: ants march, and the Selection panel comes", async () => {
      await page.click(`.pa-panel [data-atom="tools"] button[data-value="marquee"]`);
      await until("the tool is up", async () => (await photo()).params.tool === "marquee");
      await dragOn([[0.02, 0.02], [0.98, 0.5]]);
      await until("selected", async () => (await photo()).image.selection.length === 1);
      const sel = (await photo()).image.selection[0].shape;
      assert.equal(sel.type, "rect");
      assert.ok(Math.abs(sel.x - 0.02) < 0.02 && Math.abs(sel.h - 0.48) < 0.03, JSON.stringify(sel));
      await page.waitForSelector('.pa-panel:has(.pa-title:text-is("Selection"))');
      const ants = await page.evaluate(() => {
        const o = document.querySelector<HTMLCanvasElement>(".pa-image-tools")!;
        const d = o.getContext("2d")!.getImageData(0, 0, o.width, o.height).data;
        let n = 0;
        for (let i = 3; i < d.length; i += 4) if (d[i]! > 0) n++;
        return n;
      });
      assert.ok(ants > 200, `the ants are drawn (${ants})`);
      await shot("2-selected");
    });

    await test("Adjust keeps the selection with sliders of its own: its exposure lights the sky and not the field", async () => {
      await page.click('.pa-panel:has(.pa-title:text-is("Selection")) button[data-action$=".mask.add"]');
      await until("a local adjustment", async () => (await photo()).image.masks.length === 1);
      const mask = (await photo()).image.masks[0].id;
      const sky = await pixel(0.2, 0.3);
      const field = await pixel(0.2, 0.85);
      const track = page.locator(`.pa-panel [data-bind="@${id}.mask.${mask}.exposure"] .pa-track`);
      await track.waitFor();
      const tb = (await track.boundingBox())!;
      await page.mouse.click(tb.x + tb.width * 0.85, tb.y + tb.height / 2);
      await until("the server has it", async () => Number((await photo()).params[`mask.${mask}.exposure`]) > 1);
      await until("the sky is brighter", async () => (await pixel(0.2, 0.3)).sum > sky.sum + 60, 5000);
      assert.ok(Math.abs((await pixel(0.2, 0.85)).sum - field.sum) < 12, "the field is as it was");
      await shot("3-adjusted");
    });

    await test("the wand picks the sun, Ctrl+J copies it to a layer, the Move tool drags it, and Layers lists it", async () => {
      await key("w");
      await until("wand", async () => (await photo()).params.tool === "wand");
      const p = await at(0.7, 0.3);
      await page.mouse.click(p.x, p.y);
      await until("the sun is selected", async () => (await photo()).image.selection.at(-1)?.shape.type === "wand");
      await key("Control+j");
      await until("a layer", async () => (await photo()).image.layers.length === 2);
      const layer = (await photo()).image.layers[1];
      assert.equal(layer.kind, "copy");
      await page.waitForSelector('.pa-panel [data-atom="layers"]');
      assert.ok(await page.locator(`.pa-layer[data-layer="${layer.id}"].is-on`).count(), "the copy is the active layer");
      await key("v");
      await dragOn([[0.7, 0.3], [0.4, 0.3]]);
      await until("moved", async () => Number((await photo()).params[`layer.${layer.id}.dx`]) < -0.2);
      await until("a sun drawn where it was dragged", async () => (await pixel(0.4, 0.3)).r > 200, 5000);
      await shot("4-layer");
    });

    await test("the brush paints on a paint layer; text goes where it is clicked and its words are typed in its panel", async () => {
      await key("b");
      await dragOn([[0.1, 0.8], [0.3, 0.8]]);
      await until("painted", async () => (await photo()).image.layers.some((l: { kind: string; strokes?: unknown[] }) => l.kind === "paint" && l.strokes?.length === 1));
      await until("white paint", async () => (await pixel(0.2, 0.8)).sum > 700, 5000);
      await key("t");
      const p = await at(0.5, 0.7);
      await page.mouse.click(p.x, p.y);
      await until("a text layer", async () => (await photo()).image.layers.some((l: { kind: string }) => l.kind === "text"));
      const text = (await photo()).image.layers.find((l: { kind: string }) => l.kind === "text");
      const field = page.locator(`.pa-panel [data-bind="@${id}.layer.${text.id}.text"] textarea`);
      await field.fill("Hello");
      await until("the words", async () => (await photo()).params[`layer.${text.id}.text`] === "Hello");
      await shot("5-text");
    });

    await test("Remove fills what is selected in from around it", async () => {
      // Hide the copy of the sun first, so the sun left is the photo's.
      const layers = (await photo()).image.layers;
      for (const l of layers.filter((x: { kind: string }) => x.kind === "copy")) await page.click(`.pa-layer[data-layer="${l.id}"] .pa-layer-eye`);
      await key("e");
      await dragOn([[0.6, 0.15], [0.8, 0.45]]);
      await until("an ellipse", async () => (await photo()).image.selection.at(-1)?.shape.type === "ellipse");
      await page.click('.pa-panel:has(.pa-title:text-is("Selection")) button[data-action$=".layer.remove"]');
      await until("a removed layer", async () => (await photo()).image.layers.some((l: { kind: string }) => l.kind === "heal"));
      await until("no sun there", async () => (await pixel(0.7, 0.3)).r < 180, 6000);
      await shot("6-removed");
    });

    await test("the crop tool crops to the frame dragged", async () => {
      await key("Escape");
      await key("c");
      await dragOn([[0.1, 0.1], [0.6, 0.9]]);
      await until("cropped", async () => { const c = (await photo()).params.crop; return Array.isArray(c) && c[2] < 0.6; });
      await key("Escape");
      const box = (await page.locator(".pa-surface.is-image .pa-image-gl").boundingBox())!;
      assert.ok(box.width / box.height < 1.2, `narrower now (${box.width}x${box.height})`);
      await page.click(`.pa-panel [data-atom="tools"] button[data-value="pointer"]`);
    });

    await test("the agent's panacea_look shows it the picture with a grid; panacea_do selects and keeps an adjustment", async () => {
      app.script = [
        { tools: [{ name: "panacea_look", args: { surface: id } }] },
        { tools: [{ name: "panacea_do", args: { surface: id, commands: [{ name: "select.none" }, { name: "image.uncrop" }, { name: "select.rect", args: { x: 0, y: 0.6, w: 1, h: 0.4 } }, { name: "mask.add", args: { name: "Field", saturation: 40 } }] } }] },
        { text: "Done." },
      ];
      await app.turn(s, "Make the field more saturated.", 60_000);
      const seen = app.seen.at(-2)!.messages.filter((m) => m.role === "tool" || m.role === "user").map((m) => JSON.stringify(m.content)).join(" ");
      assert.match(seen, /image_url|data:image\/png/, "the picture came back to the model");
      const results = toolResults().join(" | ");
      assert.match(results, /Kept the selection as local adjustment/, results);
      await until("a second adjustment", async () => (await photo()).image.masks.some((m: { name: string }) => m.name === "Field"));
      await page.waitForSelector('.pa-panel:has(.pa-title:text-is("Field"))');
    });

    await test("with Visible work on, the agent's selection is drawn by its hand with the tool on the picture", async () => {
      await app.api("PATCH", "/api/agent-cursor", { on: true });
      app.script = [{ tools: [{ name: "panacea_do", args: { surface: id, commands: [{ name: "select.ellipse", args: { x: 0.3, y: 0.2, w: 0.3, h: 0.3 } }] } }] }, { text: "Selected." }];
      await app.turn(s, "Select a circle there.", 60_000);
      const results = toolResults().join(" | ");
      assert.match(results, /Done by hand in the Panacea window/, results);
      assert.equal((await photo()).params.tool, "ellipse", "it picked the Ellipse tool, as a person does");
      assert.equal((await photo()).image.selection.at(-1).shape.type, "ellipse");
      await app.api("PATCH", "/api/agent-cursor", { on: false });
    });

    await test("Object select: a click on the sun selects the sun, found by the model", async () => {
      const probe = await fetch(`${app.base}/api/panacea/model/magic_touch.tflite`, { method: "HEAD" }).catch(() => null);
      if (!probe?.ok) { console.log("  skip  the object model is not reachable from here"); return; }
      await key("o");
      await until("object tool", async () => (await photo()).params.tool === "object");
      // A fresh selection: the field adjustment's selection is gone with select.none in the agent's list, so this is new.
      await key("Control+d");
      const p = await at(0.7, 0.3);
      await page.mouse.click(p.x, p.y);
      await until("found", async () => (await photo()).image.selection.at(-1)?.shape.type === "object" && !!(await photo()).image.selection.at(-1)?.shape.mask, 60_000);
      // The outline holds the sun, not the sky around it.
      const mask = (await photo()).image.selection.at(-1).shape.mask as string;
      const inside = await page.evaluate(async (url) => {
        const img = new Image();
        img.src = url;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.width; c.height = img.height;
        const g = c.getContext("2d")!;
        g.drawImage(img, 0, 0);
        const [sun, sky, field] = [[0.7, 0.3], [0.15, 0.15], [0.5, 0.9]].map(([x, y]) => g.getImageData(Math.floor(x! * img.width), Math.floor(y! * img.height), 1, 1).data[0]!);
        return { sun, sky, field };
      }, `/api/panacea/${s}/mask/${mask}`);
      assert.ok(inside.sun > 128 && inside.sky < 128 && inside.field < 128, JSON.stringify(inside));
      await shot("7-object");
    });

    await test("export saves the picture with its layers and adjustments at full size", async () => {
      app.script = [{ tools: [{ name: "panacea_export", args: { surface: id } }] }, { text: "Saved." }];
      await app.turn(s, "Export it.", 60_000);
      assert.match(toolResults().join(" "), /Saved .*\.png/);
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
