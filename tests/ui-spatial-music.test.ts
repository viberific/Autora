/** Real note add/move/resize at non-unit scene zoom, with no model or iframe required. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import { newProject, newTrack, newClip, parsePitch, INSTRUMENTS, type Project } from "../src/lib/studio/model";
import { startApp, sleep } from "./e2e-harness";

async function main() {
  const exe = process.env.AUTORA_BROWSER_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
  if (!fs.existsSync(exe) || !fs.existsSync(path.join("dist", "index.html"))) { console.log("  skip  browser/build unavailable"); return; }
  const app = await startApp();
  const browser = await chromium.launch({ executablePath: exe });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  try {
    const session = await app.newSession("Scaled note input", "build");
    await app.api("POST", `/api/studio/${session}/open`);
    const got = (await app.api("GET", `/api/studio/${session}/doc`)).body as { rev: number };
    const project = newProject("Scaled note input");
    const track = newTrack(project, INSTRUMENTS.find((instrument) => !instrument.drums)!.id, "Piano");
    const clip = newClip(0, 4, "Input test");
    track.clips.push(clip); project.tracks.push(track);
    const seeded = await app.api("PUT", `/api/studio/${session}/doc`, { doc: project, rev: got.rev });
    assert.equal(seeded.status, 200);
    await page.goto(`${app.base}/?session=${session}`);
    const dock = page.getByRole("navigation", { name: "Jump to work" });
    await dock.getByRole("button", { name: "Jump to Music", exact: true }).click();
    await page.getByRole("button", { name: "Retract conversation", exact: true }).click();
    const music = page.locator('[data-engine="studio"]');
    await music.locator(`[data-clip="${clip.id}"]`).click();
    await music.locator(".st-roll .st-grid").waitFor();
    await dock.getByRole("button", { name: "Zoom out", exact: true }).click();
    const grid = music.locator(".st-roll .st-grid");
    const geometry = await grid.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      return { left: rect.left, top: rect.top, scale: rect.width / (node as HTMLElement).offsetWidth, beat: rect.width / 4 };
    });
    assert.ok(geometry.scale < 0.99 && geometry.scale > 0);
    const highest = parsePitch(await music.locator(".st-keys button").first().getAttribute("aria-label"));
    assert.ok(highest !== null);
    const visible = (await music.locator(".st-roll-scroll").boundingBox())!;
    const y = visible.y + 2.5 * 16 * geometry.scale;
    const pitch = highest - Math.floor((y - geometry.top) / (16 * geometry.scale));
    await page.mouse.click(geometry.left + 1.1 * geometry.beat, y);
    const current = async () => ((await app.api("GET", `/api/studio/${session}/doc`)).body as { doc: Project }).doc.tracks[0].clips[0].notes;
    const until = async (condition: () => Promise<boolean>) => {
      for (let n = 0; n < 80; n++) { if (await condition()) return; await sleep(75); }
      throw new Error("The real editor did not save the expected note operation.");
    };
    await until(async () => (await current()).length === 1);
    let note = (await current())[0];
    assert.equal(note.start, 1);
    assert.equal(note.pitch, pitch);
    const shown = music.locator(`[data-note="${note.id}"]`);
    const bounds = (await shown.boundingBox())!;
    await page.mouse.move(bounds.x + bounds.width * 0.25, bounds.y + bounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width * 0.25 + geometry.beat, bounds.y + bounds.height / 2 - 16 * geometry.scale, { steps: 12 });
    await page.mouse.up();
    await until(async () => (await current())[0].start === 2);
    note = (await current())[0];
    assert.equal(note.pitch, pitch + 1);
    const originalLength = note.length;
    const resizeBy = clip.length - note.start - originalLength >= 1 ? 1 : -0.25;
    const edge = (await shown.locator('[data-edge="1"]').boundingBox())!;
    await page.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2);
    await page.mouse.down();
    await page.mouse.move(edge.x + edge.width / 2 + geometry.beat * resizeBy, edge.y + edge.height / 2, { steps: 12 });
    await page.mouse.up();
    try { await until(async () => (await current())[0].length !== originalLength); }
    catch { throw new Error(`Resize did not change the note: ${JSON.stringify({ note: (await current())[0], originalLength, resizeBy })}`); }
    assert.equal((await current())[0].length, originalLength + resizeBy);
    console.log("  ok  add, drag and resize preserve logical beats/pitch at scene zoom");
  } finally { await browser.close(); await app.stop(); }
}
main().catch((error) => { console.error(error); process.exit(1); });
