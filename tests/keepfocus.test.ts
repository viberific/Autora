/**
 * The person's place is theirs (R17, src/lib/keepFocus.ts): an editor's frame that takes the keyboard while the agent's
 * hand types in it gives it back to the chat when the hand is done, with the caret where it was, and the keys pressed
 * meanwhile are typed into the chat, not lost. Run in Chromium, with a real frame taking focus the way an editor does.
 *
 *   npx tsx tests/keepfocus.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildSync } from "esbuild";
import { chromium } from "playwright-core";
import { CHROME } from "./chrome";

const here = import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname);
const lib = buildSync({
  entryPoints: [path.join(here, "../src/lib/keepFocus.ts")], bundle: true, write: false, format: "iife", globalName: "keep",
}).outputFiles[0].text;

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

if (!fs.existsSync(CHROME)) { console.log("  skip  no browser here"); process.exit(0); }
const browser = await chromium.launch({ executablePath: CHROME });
try {
  const page = await browser.newPage();
  const fresh = async () => {
    await page.setContent(`<textarea aria-label="Task"></textarea><input id="other"><iframe srcdoc="<div id=cell contenteditable>A1</div>"></iframe>`);
    await page.addScriptTag({ content: lib });
    await page.waitForFunction(() => document.querySelector("iframe")?.contentDocument?.getElementById("cell"));
    await page.click("textarea");
    await page.keyboard.type("hello world");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
  };
  // What a hand does in the frame: the editor focuses its cell, which takes the keyboard from the page.
  const handStarts = () => page.evaluate(() => {
    const frame = document.querySelector("iframe")!;
    (window as any).held = (window as any).keep.holdFocus(frame);
    frame.contentDocument!.getElementById("cell")!.focus();
    return document.activeElement === frame;
  });

  await test("the frame does take the keyboard (what the fix is for)", async () => {
    await fresh();
    assert.equal(await handStarts(), true);
  });

  await test("when the hand is done, the chat has the keyboard back with the caret where it was", async () => {
    await fresh();
    await handStarts();
    const back = await page.evaluate(() => {
      (window as any).held.release();
      const t = document.querySelector("textarea")!;
      return { active: document.activeElement === t, at: t.selectionStart };
    });
    assert.deepEqual(back, { active: true, at: 9 });
    await page.keyboard.type("X");
    assert.equal(await page.inputValue("textarea"), "hello worXld");
  });

  await test("keys pressed while the frame had the keyboard are typed into the chat, where the caret was", async () => {
    await fresh();
    await handStarts();
    await page.evaluate(() => { const h = (window as any).held; for (const k of ["a", "b", "Backspace", "c", "Shift"]) h.type(k); h.release(); });
    assert.equal(await page.inputValue("textarea"), "hello woracld");
    await page.keyboard.type("!");
    assert.equal(await page.inputValue("textarea"), "hello worac!ld");
  });

  await test("a place the person chose since is left alone", async () => {
    await fresh();
    await handStarts();
    await page.click("#other");
    await page.evaluate(() => (window as any).held.release());
    assert.equal(await page.evaluate(() => document.activeElement?.id), "other");
  });

  await test("nothing is held when the person was not typing anywhere", async () => {
    await fresh();
    await page.evaluate(() => (document.activeElement as HTMLElement).blur());
    await handStarts();
    await page.evaluate(() => (window as any).held.release());
    assert.equal(await page.evaluate(() => document.activeElement?.tagName), "IFRAME");
  });
} finally {
  await browser.close();
}
console.log(`\n${passed} passed`);
