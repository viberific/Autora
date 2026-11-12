/**
 * Panacea at rest, in a real browser: the work and what it needs now, nothing else (CLAUDE.md, "controls appear when the
 * work needs them"; docs/TRY-IT-2026-11-11-PANACEA.md). One request for a chart leaves one chart, readable and clear of
 * the conversation; an app's window is its work and its name until the person is in it; the thread speaks in words.
 *
 *   npx tsx tests/ui-panacea-rest.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { chromium, type Page } from "playwright-core";
import { sleep, startApp, turnStart, type Scripted } from "./e2e-harness";
import { CHROME } from "./chrome";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}
const CSV = "Month,Region,Revenue\n2025-07,EU,120\n2025-07,US,200\n2025-08,EU,150\n2025-08,US,260\n2025-08,APAC,90\n";

async function main() {
  if (!CHROME || !fs.existsSync(CHROME)) { console.log("  skip  no browser here"); return; }
  if (!fs.existsSync("dist/index.html")) { console.log("  skip  no build (npm run build)"); return; }
  const app = await startApp();
  const browser = await chromium.launch({ executablePath: CHROME, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  const errors: string[] = [];
  try {
    await app.api("PATCH", "/api/agent-cursor", { on: false });
    const s = await app.newSession("Rest", "build");
    const page: Page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${app.base}/?session=${s}`);
    await page.waitForSelector('textarea[aria-label="Ask Autora"]');
    const doc = async () => (await app.api("GET", `/api/panacea/${s}/doc`)).body.doc;
    const until = async (what: string, fn: () => Promise<boolean> | boolean, ms = 10000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) { if (await fn()) return; await sleep(100); }
      throw new Error(`timed out: ${what}`);
    };
    /** One turn of scripted steps: each is the agent's next reply. */
    const turn = async (text: string, steps: Scripted[]) => {
      const queue = [...steps];
      app.decide = (req) => (/You check one action/.test(req.system) ? { text: '{"destructive": false, "requested": true}' }
        : req.tools.length > 5 ? (turnStart(req) || queue.length ? queue.shift() ?? { text: "Done." } : { text: "Done." }) : { text: "ok" });
      await app.turn(s, text, 40_000);
      await sleep(900);
    };
    const zoom = () => page.evaluate(() => new DOMMatrix(getComputedStyle(document.querySelector(".pa-world")!).transform).a);

    await test("asking for one chart leaves one chart: the starter chart and the standing offer give way to the agent's", async () => {
      await turn("Chart revenue by region and write a summary", [
        { tools: [{ name: "panacea_surface", args: { csv: CSV, title: "Sales" } }] },
        { tools: [{ name: "panacea_place", args: { recipe: "data.bar", why: "Revenue by region, as you asked." } }] },
        { tools: [{ name: "panacea_surface", args: { document: "# Q3 summary\n\nRevenue grew in the US.", mode: "agent" } }] },
        { text: "Done." },
      ]);
      const d = await doc();
      const table = d.surfaces.find((x: { kind: string }) => x.kind === "data");
      const mine = d.panels.filter((p: { context: string }) => p.context === table.id);
      assert.deepEqual(mine.filter((p: { recipe: string }) => /^data\.(bar|line|explore)$/.test(p.recipe)).map((p: { recipe: string }) => p.recipe), ["data.bar"]);
      assert.ok(!mine.some((p: { state: string; by: string }) => p.state === "ghost" && p.by === "rule"), "no offer of the same chart beside it");
      assert.ok(mine.some((p: { recipe: string }) => p.recipe === "data.filter-category"), "the filter that came with the table stays");
    });

    await test("a document with no title is called by its heading, not \"Document\"", async () => {
      assert.equal((await doc()).surfaces.find((x: { kind: string }) => x.kind === "doc").title, "Q3 summary");
    });

    await test("Autora's own framing keeps the newest piece readable and clear of the conversation", async () => {
      assert.ok(await zoom() >= 0.6, `the board is at ${await zoom()}`);
      const hit = await page.evaluate(() => {
        const chat = document.querySelector(".conversation-flow.is-float")!.getBoundingClientRect();
        const work = document.querySelector(".pa-surface.is-doc")!.getBoundingClientRect();
        return work.left < chat.right && work.right > chat.left && work.top < chat.bottom && work.bottom > chat.top;
      });
      assert.equal(hit, false, "the summary is not under the conversation window");
    });

    await test("the thread says what was done in words: no key=value, and no instructions printed on the document", async () => {
      await until("the steps are in the thread", async () => (await page.locator(".steps-top").count()) > 0);
      const lines = await page.locator(".steps-top").allInnerTexts();
      assert.ok(lines.length > 0, await page.evaluate(() => (document.querySelector(".conversation-flow") as HTMLElement).innerText.slice(0, 400) + " || " + [...document.querySelectorAll(".conversation-flow [class]")].map((e) => e.className.toString().split(" ")[0]).filter((c, i, a) => a.indexOf(c) === i).join(",")));
      for (const line of lines) assert.ok(!/\w=\S/.test(line), `plumbing in the thread: "${line}"`);
      assert.match(await page.locator(".pa-surface.is-doc .pa-doc-bar").innerText(), /^\s*Autora writes\s*$/);
    });

    await test("a jump to the table shows it with its panels, and its header sorts by a column", async () => {
      await page.getByRole("navigation", { name: "Jump to work", exact: true }).getByRole("button", { name: "Jump to Sales", exact: true }).click();
      await sleep(700);
      const off = await page.evaluate(() => {
        const live = [...document.querySelectorAll<HTMLElement>(".pa-panel")].filter((p) => p.querySelector(".pa-chart, [data-atom='chips']"));
        return live.filter((p) => { const r = p.getBoundingClientRect(); return r.left < 0 || r.right > innerWidth || r.top < 0 || r.bottom > innerHeight; }).length;
      });
      assert.equal(off, 0, "the table's panels are on screen with it");
      await page.locator(".pa-surface.is-data th button", { hasText: "Revenue" }).click();
      await until("largest first", async () => (await page.locator(".pa-surface.is-data tbody tr").first().innerText()).includes("260"));
      await page.locator(".pa-surface.is-data th button", { hasText: "Revenue" }).click();
      await until("smallest first", async () => (await page.locator(".pa-surface.is-data tbody tr").first().innerText()).includes("90"));
      await until("saved", async () => (await doc()).surfaces.find((x: { kind: string }) => x.kind === "data").params.sort === "Revenue");
    });

    await test("pasted words keep their lines, and the page is called by its first one", async () => {
      await page.evaluate(() => {
        const dt = new DataTransfer();
        dt.setData("text/plain", "Meeting notes\nWe agreed to ship Friday.\nAna owns QA.");
        document.querySelector(".pa-board")!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
      });
      await until("the page is there", async () => (await doc()).surfaces.some((x: { title: string }) => x.title === "Meeting notes"));
      assert.equal(await page.locator('.pa-surface[aria-label^="Meeting notes"] .ProseMirror p').count(), 3);
    });

    await test("the agent held back from the person's words is said in plain words, not as a failure", async () => {
      await turn("Help me brainstorm a story", [
        { tools: [{ name: "panacea_surface", args: { board: "My story" } }] },
        { tools: [{ name: "panacea_board", args: { ops: [{ op: "add", text: "A keeper named Mara", x: 40, y: 40 }] } }] },
        { text: "Who do you see?" },
      ]);
      const last = page.locator(".steps").last();
      assert.match(await last.innerText(), /yours to write/i);
      assert.equal(await last.locator(".cell-chip.is-bad").count(), 0);
      assert.match(await page.locator(".pa-surface.is-board .pa-doc-bar").innerText(), /^\s*You write\s*$/);
    });

    await test("an app's window at rest is its work and its name; its controls come when the person is in it", async () => {
      assert.equal((await app.api("POST", `/api/studio/${s}/open`)).status, 200);
      const win = page.locator('.pw-engine[data-work="engine:studio"]');
      await win.waitFor();
      await sleep(1200);
      assert.equal(await page.locator(".pw-engine-context").count(), 0, "no sentence about the app on its window");
      assert.ok(!(await win.innerText()).includes("Saved as you go"), "saving is silent");
      await page.getByRole("navigation", { name: "Jump to work", exact: true }).getByRole("button", { name: "Jump to Music", exact: true }).click();
      await sleep(900);
      const opacity = (sel: string) => win.locator(sel).first().evaluate((e) => Number(getComputedStyle(e).opacity));
      // The work is elsewhere: the pointer on the bare board, nothing in the window focused or last touched.
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.mouse.move(1380, 60);
      await page.mouse.click(1380, 60);
      await until("the controls have gone", async () => (await opacity('button[aria-label^="Maximise"]')) === 0 && (await opacity(".st-save-btn")) === 0);
      assert.equal(await opacity(".st-song-name"), 1, "its name stays");
      const box = (await win.boundingBox())!;
      await page.mouse.move(box.x + box.width - 200, box.y + 120);
      await until("the controls are back", async () => (await opacity('button[aria-label^="Maximise"]')) === 1 && (await opacity(".st-save-btn")) === 1);
    });

    await test("nothing went wrong in the page", async () => { assert.deepEqual(errors, []); });
    console.log(`\n${passed} ui-panacea-rest tests passed`);
  } finally {
    await browser.close();
    await app.stop();
  }
}
main().catch((err) => { console.error(err); process.exit(1); });
