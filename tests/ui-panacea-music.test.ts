/**
 * Panacea's Music panels in a real browser (docs/PANACEA-GAPS.md, G1): the Tempo stepper on a Transport panel changes the
 * song and the Music window's tempo follows; a change made in the Music window shows on the panel; and the Track list
 * on a Channel panel picks the track whose volume the slider moves.
 *
 * Needs a build (npm run build) and a browser (AUTORA_BROWSER_PATH=/opt/pw-browsers/chromium-1243/chrome-linux64/chrome).
 *
 *   npx tsx tests/ui-panacea-music.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { chromium, type Page } from "playwright-core";
import { newProject, newTrack, type Project } from "../src/lib/studio/model";
import { sleep, startApp } from "./e2e-harness";
import { CHROME } from "./chrome";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

async function main() {
  const exe = CHROME;
  if (!exe || !fs.existsSync(exe)) { console.log("  skip  no browser here"); return; }
  if (!fs.existsSync("dist/index.html")) { console.log("  skip  no build (npm run build)"); return; }
  const app = await startApp();
  const browser = await chromium.launch({ executablePath: exe });
  const page: Page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await app.api("PATCH", "/api/agent-cursor", { on: false });
    const s = await app.newSession("Music panels", "build");
    const doc = async () => ((await app.api("GET", `/api/studio/${s}/doc`)).body as { doc: Project }).doc;
    const until = async (what: string, fn: () => Promise<boolean> | boolean, ms = 8000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) { if (await fn()) return; await sleep(100); }
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
      await page.waitForSelector(`.pa-panel[aria-label="${title}"]`, { timeout: 5000 }).catch(async (e) => { throw new Error(`${e.message}\n${await page.locator(".pa-board").evaluate((b) => b.parentElement?.innerText.slice(0, 400))}`); });
    };

    // Panels first, on the empty board; then the person's song arrives and the Music window with it.
    await place("music.transport", "transport", "Transport", 60, 80);
    await place("music.channel", "channel", "Channel", 460, 80);
    // A song with two tracks, made as the person's window would save it.
    await app.api("POST", `/api/studio/${s}/open`);
    const got = (await app.api("GET", `/api/studio/${s}/doc`)).body as { rev: number };
    const song = newProject("Panel song");
    song.bpm = 100;
    song.tracks.push(newTrack(song, "keys", "Keys"), newTrack(song, "bass", "Bass"));
    assert.equal((await app.api("PUT", `/api/studio/${s}/doc`, { doc: song, rev: got.rev })).status, 200);
    await test("the Tempo stepper changes the song, and the Music window shows the new tempo", async () => {
      const tempo = page.locator('.pa-panel input[aria-label="Tempo"]');
      await tempo.waitFor();
      await until("the panel shows the song's tempo", async () => (await tempo.inputValue()) === "100");
      await page.click('.pa-panel button[aria-label="More Tempo"]');
      await until("the song has the new tempo", async () => (await doc()).bpm === 101);
      const rail = page.locator('.rail-bar button[aria-label="Song"]');
      // The Music window opens partly off the board's screen (window layout is G2), so its controls are pressed in place.
      if (await rail.count()) await rail.first().dispatchEvent("click");
      else {
        await page.locator('.rail-bar button[aria-label="All tools"]').dispatchEvent("click");
        await page.locator(".rail-grid .rail-tile", { hasText: /^Song$/ }).dispatchEvent("click");
      }
      await until("the Music window shows 101", async () => (await page.locator('[data-engine="studio"] [aria-label="Tempo in beats per minute"]').inputValue()) === "101");
    });

    await test("a tempo change in the Music window shows on the panel", async () => {
      await page.locator('[data-engine="studio"] [aria-label="Faster"]').dispatchEvent("click");
      await page.locator('[data-engine="studio"] [aria-label="Faster"]').dispatchEvent("click");
      await until("the song is 103", async () => (await doc()).bpm === 103);
      await until("the panel shows 103", async () => (await page.locator('.pa-panel input[aria-label="Tempo"]').inputValue()) === "103");
    });

    await test("a Channel panel's Track list picks the track whose volume the slider moves", async () => {
      const panel = page.locator('.pa-panel:has([data-bind="music.vol"])');
      await panel.waitFor();
      await panel.locator('[data-bind="music.track"] .pa-select-btn').click();
      await panel.getByRole("option", { name: "Bass", exact: true }).click();
      const track = panel.locator('[data-bind="music.vol"] .pa-track');
      const box = (await track.boundingBox())!;
      await page.mouse.click(box.x + box.width * 0.25, box.y + box.height / 2);
      await until("Bass is at about 25", async () => { const t = (await doc()).tracks; return Math.abs(t[1]!.volume * 100 - 25) <= 3; });
      assert.notEqual(Math.round((await doc()).tracks[0]!.volume * 100), 25, "the other track is untouched");
    });
    assert.deepEqual(errors, [], "no page errors");
  } finally { await browser.close(); await app.stop(); }
  console.log(`\n${passed} ui-panacea-music tests passed`);
}
main().catch((e) => { console.error(e); process.exit(1); });
