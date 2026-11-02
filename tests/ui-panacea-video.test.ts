/**
 * Panacea's Video panels in a real browser with the real editor (docs/PANACEA-GAPS.md, G1): the Project panel's Aspect
 * changes the film's canvas, the Picture panel's Zoom changes the clip, the Title panel's words change the title in
 * the editor, and a change the agent makes to a clip shows on the panel.
 *
 * Needs a build (npm run build, with opencut-editor) and a browser (AUTORA_BROWSER_PATH=/opt/pw-browsers/chromium-1243/chrome-linux64/chrome).
 *
 *   npx tsx tests/ui-panacea-video.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import zlib from "node:zlib";
import { chromium, type Page } from "playwright-core";
import { readVideo, type VideoState } from "../src/lib/panacea/apps/video";
import { sleep, startApp } from "./e2e-harness";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

/** A 64x36 PNG, solid violet, made here so there is no file to carry. */
function png(): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(4); head.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([head, body, crc]);
  };
  const w = 64, h = 36;
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.concat(Array.from({ length: w }, () => Buffer.from([110, 91, 255])))]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(Buffer.concat(Array.from({ length: h }, () => row)))), chunk("IEND", Buffer.alloc(0))]);
}

async function main() {
  const exe = process.env.AUTORA_BROWSER_PATH || ["/opt/pw-browsers/chromium-1243/chrome-linux64/chrome", "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", "/opt/pw-browsers/chromium"].find((p) => fs.existsSync(p));
  if (!exe || !fs.existsSync(exe)) { console.log("  skip  no browser here"); return; }
  if (!fs.existsSync("dist/opencut-editor/index.html")) { console.log("  skip  the editor is not built (npm run build)"); return; }
  const app = await startApp();
  const browser = await chromium.launch({ executablePath: exe });
  const page: Page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await app.api("PATCH", "/api/agent-cursor", { on: false });
    const up = await fetch(`${app.base}/api/artifacts`, { method: "POST", headers: { "Content-Type": "application/octet-stream", "X-File-Name": "violet.png" }, body: new Uint8Array(png()) });
    const picture = (await up.json()).artifact.id as string;
    const s = await app.newSession("Video panels", "build");
    const project = async () => ((await app.api("GET", `/api/opencut/${s}/project`)).body as { state: VideoState | null }).state;
    const until = async (what: string, fn: () => Promise<boolean> | boolean, ms = 15_000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) { if (await fn()) return; await sleep(150); }
      throw new Error(`timed out: ${what}`);
    };
    await page.goto(`${app.base}/?session=${s}`);
    await page.waitForSelector('textarea[aria-label="Ask Autora"]');
    const place = async (recipe: string, word: string, title: string, x: number, y: number) => {
      const box = (await page.locator(".pa-board").boundingBox())!;
      await page.mouse.dblclick(box.x + x, box.y + y);
      await page.waitForSelector(".pa-summon-q");
      await page.fill(".pa-summon-q", word);
      await page.click(`.pa-summon [data-recipe="${recipe}"]`);
      await page.waitForSelector(`.pa-panel[aria-label="${title}"]`, { timeout: 5000 });
    };
    // Panels first, on the empty board; then the film arrives and the Video window with it.
    await place("video.project", "aspect", "Project", 40, 60);
    await place("video.frame", "picture", "Picture", 360, 60);
    await place("video.title", "title", "Title", 680, 60);

    const said = () => app.seen.map((r) => JSON.stringify(r.messages.filter((m) => m.role === "tool"))).join("\n").replace(/\\"/g, '"').replace(/\\n/g, "\n");
    let steps: Array<{ name: string; args: Record<string, unknown> }> = [
      { name: "video_open", args: { new: "Panel cut" } },
      { name: "video_import", args: { file: picture } },
      { name: "video_edit", args: { action: "add_clip", mediaId: "@media" } },
      { name: "video_edit", args: { action: "add_text", text: "Hello", start: 1, duration: 2 } },
    ];
    let n = 0;
    const play = (turnSteps: typeof steps) => {
      steps = turnSteps; n = 0;
      app.decide = (req) => {
        if (/You check one action/.test(req.system)) return { text: '{"destructive": false, "requested": true}' };
        if (n >= steps.length) return { text: "Done." };
        const step = steps[n++]!;
        if (step.args.mediaId === "@media") {
          const id = /imported image "violet.png" as ([0-9a-f-]+)/i.exec(said())?.[1];
          return { tools: [{ name: step.name, args: { ...step.args, mediaId: id } }] };
        }
        return { tools: [{ name: step.name, args: step.args }] };
      };
    };
    play(steps);
    const events = await app.turn(s, "make a short cut from the picture with a title", 150_000);
    assert.deepEqual(events.filter((e) => e.kind === "tool.error").map((e) => e.payload.error), [], "no tool failed");
    const frame = () => project();

    await test("the panels show the film they were put beside", async () => {
      await until("the editor answers a read", async () => (await frame()) !== null);
      const aspect = page.locator('.pa-panel[aria-label="Project"] [data-bind="video.aspect"]');
      await until("Aspect shows 16:9", async () => (await aspect.locator('[aria-checked="true"], .is-on').first().textContent().catch(() => "")) ?.trim() === "16:9");
      await until("Title shows its words", async () => (await page.locator('.pa-panel[aria-label="Title"] [data-bind="video.title"] input, .pa-panel[aria-label="Title"] [data-bind="video.title"] textarea').first().inputValue().catch(() => "")) === "Hello");
    });

    await test("the Aspect control changes the film's canvas in the editor", async () => {
      await page.locator('.pa-panel[aria-label="Project"]').getByRole("radio", { name: "9:16", exact: true }).click();
      await until("the canvas is 1080x1920", async () => { const p = await frame(); return p?.canvas.width === 1080 && p.canvas.height === 1920; });
    });

    await test("the Zoom slider changes the picture clip, not the title", async () => {
      const track = page.locator('.pa-panel[aria-label="Picture"] [data-bind="video.zoom"] .pa-track');
      const box = (await track.boundingBox())!;
      await page.mouse.click(box.x + box.width * 0.5, box.y + box.height / 2);
      await until("the picture is about 1.6x", async () => { const p = await frame(); const z = p ? readVideo(p, "video.zoom") : undefined; return typeof z === "number" && Math.abs(z - 1.6) < 0.2; });
      const p = (await frame())!;
      const title = p.tracks.flatMap((t) => t.clips).find((c) => c.type === "text")!;
      assert.equal(title.params?.["transform.scaleX"] ?? 1, 1, "the title is untouched");
    });

    await test("the Title field changes the words in the editor", async () => {
      const field = page.locator('.pa-panel[aria-label="Title"] [data-bind="video.title"]').locator("input, textarea").first();
      await field.fill("Hello again");
      await until("the editor has the new words", async () => (await frame())?.tracks.flatMap((t) => t.clips).some((c) => c.type === "text" && c.text === "Hello again") === true);
    });

    await test("a change the agent makes to the clip shows on the panel", async () => {
      const clip = (await frame())!.tracks.flatMap((t) => t.clips).find((c) => c.type === "image")!;
      play([{ name: "video_edit", args: { action: "set", elementId: clip.id, params: { opacity: 0.3 } } }]);
      const turn = await app.turn(s, "make the picture see-through", 90_000);
      assert.deepEqual(turn.filter((e) => e.kind === "tool.error").map((e) => e.payload.error), [], "no tool failed");
      await until("the Opacity slider shows 30", async () => (await page.locator('.pa-panel[aria-label="Picture"] [data-bind="video.opacity"] .pa-track').getAttribute("aria-valuenow")) === "30", 15_000);
    });
    assert.deepEqual(errors, [], "no page errors");
  } finally { await browser.close(); await app.stop(); }
  console.log(`\n${passed} ui-panacea-video tests passed`);
}
main().catch((e) => { console.error(e); process.exit(1); });
