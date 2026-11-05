/**
 * The Office tool bar follows the document (office/shim/rail.js, `RULES`; docs/TOOL-RAIL.md): what the bar shows is what its buttons
 * are marked as needed (the rest are collapsed and faded out: in the page, but out of reach), read in a real browser with the real
 * editors. One app at a time as its rules are written: Pages now.
 *
 * Needs the app and the Office editors built (npm run build, then node scripts/build-office.mjs); skips without a browser.
 *
 *   npx tsx tests/ui-office-needs.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { chromium, type Frame, type Page } from "playwright-core";
import { sleep, startApp } from "./e2e-harness";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}
const guard = (req: { system: string }) => (/You check one action/.test(req.system) ? { text: '{"destructive": false, "requested": true}' } : null);

async function until(what: string, fn: () => Promise<boolean>, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn().catch(() => false)) return; await sleep(200); }
  throw new Error(`timed out waiting for ${what}`);
}
const editorOf = (page: Page): Frame | undefined => page.frames().find((f) => f !== page.mainFrame() && f.url().includes("/office-app/"));

async function main() {
  const exe = process.env.AUTORA_BROWSER_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
  if (!fs.existsSync(exe)) { console.log("  skip  no browser here"); return; }
  if (!fs.existsSync("dist/office/web/docs/index.html")) { console.log("  skip  the Office editors are not built"); return; }
  const app = await startApp();
  const browser = await chromium.launch({ executablePath: exe });
  try {
    const open = async (tool: { name: string; args: Record<string, unknown> }, name: string) => {
      const s = await app.newSession(name, "build");
      let n = 0;
      app.decide = (req) => guard(req) ?? (n++ === 0 ? { tools: [tool] } : { text: "Done." });
      await app.turn(s, "go", 120_000);
      app.decide = null;
      const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
      await page.goto(`${app.base}/?session=${s}`);
      await page.waitForSelector(".office-window");
      await until("the editor's frame", async () => !!editorOf(page), 40_000);
      const frame = editorOf(page)!;
      await frame.waitForSelector("#autora-rail", { timeout: 40_000 });
      // The rail reads every ribbon command, tab by tab, as soon as the editor is up; a press during that lands on whatever tab is open.
      await frame.waitForSelector("html[data-rail-scanned]", { state: "attached", timeout: 40_000 });
      // The buttons the bar has marked as needed; the rest are collapsed and faded out.
      const shown = async (): Promise<string[]> => (await frame.evaluate(() => [...document.querySelectorAll('#autora-rail button[data-tool]:not([data-need="0"])')].map((b) => b.getAttribute("aria-label") ?? ""))) as string[];
      return { page, frame, shown };
    };

    {
      const { page, frame, shown } = await open({ name: "office_create", args: { type: "docx", name: "memo", markdown: "# Memo\n\nHello team.\n" } }, "pages");
      await test("pages: words and a caret give the paragraph tools; picking words brings the text tools; Undo waits for a change; they fade away again", async () => {
        await until("the document to be drawn", async () => (await frame.locator("text=Hello team.").count()) > 0, 40_000);
        // Put the caret in the words (from inside the page: Playwright's click into this frame, in the scaled workspace, does not always land).
        const caret = () => frame.evaluate(() => { const p = [...document.querySelectorAll(".ProseMirror p")].find((x) => /Hello team/.test(x.textContent ?? ""))!; const r = document.createRange(); r.selectNodeContents(p); r.collapse(false); const s = getSelection()!; s.removeAllRanges(); s.addRange(r); (document.querySelector(".ProseMirror") as HTMLElement).focus(); });
        await caret();
        // Keys go to the editor's frame once the frame itself has the page's focus.
        await page.locator("iframe").first().focus();
        await caret();
        await until("the paragraph tools", async () => (await shown()).includes("Centre"));
        const idle = await shown();
        for (const l of ["Bold", "Italic", "Underline", "Bullets", "Numbering", "Align left", "Centre"]) assert.ok(idle.includes(l), `${l} is on the bar with a caret in words: ${idle}`);
        for (const l of ["Highlight", "Text colour", "Undo", "Redo"]) assert.ok(!idle.includes(l), `${l} waits: ${idle}`);
        if (process.env.OFFICE_SHOTS) await page.screenshot({ path: `${process.env.OFFICE_SHOTS}/pages-caret.png` });
        // Pick the words (with the keyboard, as a person does: the editor takes its selection from real keys): what can be done to them comes on.
        await page.keyboard.press("Control+A");
        await until("the text tools to arrive", async () => (await shown()).includes("Highlight") && (await shown()).includes("Text colour"));
        await sleep(400);
        if (process.env.OFFICE_SHOTS) await page.screenshot({ path: `${process.env.OFFICE_SHOTS}/pages-picked.png` });
        // Bold them (the editor's own shortcut): that is a change, so Undo has something to take back.
        await page.keyboard.press("Control+B");
        await until("Undo to arrive after a change", async () => (await shown()).includes("Undo"));
        // The bar's tools still work as they did: Italic pressed there italicises the picked words.
        await frame.evaluate(() => document.querySelector<HTMLElement>('#autora-rail [aria-label="Italic"]')!.click());
        await until("the picked words to be italic", async () => (await frame.locator(".ProseMirror em, .ProseMirror i").count()) > 0, 8000);
        await page.keyboard.press("ArrowRight");
        await until("the text tools to fade away with nothing picked", async () => !(await shown()).includes("Highlight"));
        assert.ok((await shown()).includes("Bold"), "and the bar's always-tools stay");
      });
      await page.close();
    }

    {
      const { page, frame, shown } = await open({ name: "office_create", args: { type: "xlsx", name: "pets", rows: [["Breed", "Weight"], ["Beagle", 10.5], ["Corgi", 12]] } }, "sheets");
      await test("sheets: a cell gets the essentials; a block of cells gets how it sits, wraps and is written as numbers; they fade away again", async () => {
        const go = async (address: string) => {
          // Typed into the name box, as the agent's hand does: the grid is a canvas and has nothing to click.
          await page.locator("iframe").first().focus();
          await frame.evaluate(() => { const i = document.querySelector<HTMLInputElement>("[data-u-comp='defined-name'] input")!; i.focus(); i.select(); });
          await page.keyboard.type(address);
          await page.keyboard.press("Enter");
        };
        await until("the grid to be up", async () => (await shown()).includes("Bold"), 40_000);
        await go("B2");
        await sleep(900);
        const one = await shown();
        for (const l of ["Bold", "Italic", "Underline", "Fill colour", "AutoSum", "Insert row", "Insert column"]) assert.ok(one.includes(l), `${l} is on the bar with a cell picked: ${one}`);
        for (const l of ["Align left", "Wrap text", "Currency", "Percent", "Undo", "Redo"]) assert.ok(!one.includes(l), `${l} waits: ${one}`);
        if (process.env.OFFICE_SHOTS) await page.screenshot({ path: `${process.env.OFFICE_SHOTS}/sheets-cell.png` });
        await go("A1:B3");
        await until("the block tools to arrive", async () => { const now = await shown(); return now.includes("Align left") && now.includes("Wrap text") && now.includes("Currency") && now.includes("Percent"); });
        await sleep(400);
        if (process.env.OFFICE_SHOTS) await page.screenshot({ path: `${process.env.OFFICE_SHOTS}/sheets-range.png` });
        await go("B2");
        await until("the block tools to fade away with one cell picked", async () => !(await shown()).includes("Currency"));
        assert.ok((await shown()).includes("Bold"), "and the essentials stay");
      });
      await page.close();
    }
    {
      const spec = (title: string) => ({ title, type: "cover", background: "#0E1A2B", elements: [{ type: "shape", shape: "rect", x: 80, y: 80, w: 600, h: 120, fill: "#1F3A5F", paragraphs: [{ align: "left", runs: [{ text: title, sizePt: 40, color: "#FFFFFF" }] }] }] });
      const { page, frame, shown } = await open({ name: "office_create", args: { type: "pptx", name: "pitch", spec: { pages: [spec("Hello"), spec("Second")] } } }, "slides");
      await test("slides: a deck gets slide tools; picking a box on the slide brings the text and arrange tools; picking nothing takes them away", async () => {
        await until("the deck's tools", async () => (await shown()).includes("New slide"), 40_000);
        await sleep(1500);
        const idle = await shown();
        for (const l of ["New slide", "Layout", "Present"]) assert.ok(idle.includes(l), `${l} is on the bar with a deck open: ${idle}`);
        for (const l of ["Bold", "Italic", "Underline", "Text colour", "Format pane", "Undo", "Redo"]) assert.ok(!idle.includes(l), `${l} waits until something is picked: ${idle}`);
        // A real press on the slide (the slide is a canvas, so there is nothing in the page to click): the box at the top left of it.
        const stage = async () => (await frame.evaluate(`(() => { const r = document.querySelector(".stage-wrap").getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`)) as { x: number; y: number; w: number; h: number };
        // The frame sits in the scaled workspace: a point inside it is scaled to become a point of the page.
        const at = async (fx: number, fy: number) => {
          const f = (await page.locator("iframe").first().boundingBox())!;
          const st = await stage();
          const k = f.width / ((await frame.evaluate("window.innerWidth")) as number);
          await page.mouse.click(f.x + (st.x + st.w * fx) * k, f.y + (st.y + st.h * fy) * k);
        };
        await at(0.30, 0.20);
        await until("the text tools to arrive", async () => { const now = await shown(); return now.includes("Bold") && now.includes("Italic") && now.includes("Underline"); });
        if (process.env.OFFICE_SHOTS) await page.screenshot({ path: `${process.env.OFFICE_SHOTS}/slides-picked.png` });
        assert.ok((await shown()).includes("New slide"), "the slide tools stay");
        // Then a pause (two quick presses are a double-click) and a press on empty slide: nothing is picked.
        await sleep(900);
        await at(0.90, 0.90);
        await until("the text tools to fade away with nothing picked", async () => !(await shown()).includes("Bold"));
      });
      await page.close();
    }
  } finally {
    await browser.close();
    await app.stop();
  }
  console.log(`\n${passed} passed`);
}
main().catch((e) => { console.error(e); process.exit(1); });
