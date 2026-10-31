/**
 * A Panacea board as a person uses it, in a real browser: summoned from the picker, cards typed where they double-click,
 * dragged, linked by dragging from one card's dot onto another; the agent's question answered with a linked card; the
 * agent refused a card of its own while the words are the person's, and given one once they say Autora writes.
 *
 *   npx tsx tests/ui-panacea-board.test.ts          (PANACEA_SHOTS=<dir> keeps screenshots)
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { chromium, type Page } from "playwright-core";
import { sleep, startApp } from "./e2e-harness";
import { workspaceReady } from "./ui-workspace-ready";

let passed = 0;
let onFail: () => Promise<void> = async () => undefined;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); await onFail().catch(() => undefined); throw err; }
}

interface Card { id: string; x: number; y: number; text: string; ask?: boolean }

async function main() {
  const exe = process.env.AUTORA_BROWSER_PATH || ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome", "/opt/pw-browsers/chromium"].find((p) => fs.existsSync(p));
  if (!exe || !fs.existsSync(exe)) { console.log("  skip  no browser here"); return; }
  if (!fs.existsSync("dist/index.html")) { console.log("  skip  no build (npm run build)"); return; }
  const shots = process.env.PANACEA_SHOTS || "";
  const app = await startApp();
  const browser = await chromium.launch({ executablePath: exe });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const errors: string[] = [];
  const page: Page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  const shot = async (name: string) => { if (shots) await page.screenshot({ path: `${shots}/${name}.png` }); };
  onFail = () => shot("board-failed");
  try {
    await app.api("PATCH", "/api/agent-cursor", { on: false });
    const s = await app.newSession("Board", "build");
    await page.goto(`${app.base}/?session=${s}`);
    await page.waitForSelector('textarea[aria-label="Ask Autora"]');
    const board = async () => (await app.api("GET", `/api/panacea/${s}/doc`)).body.doc.surfaces.find((x: { kind: string }) => x.kind === "board")?.board as { mode: string; cards: Card[]; links: Array<{ from: string; to: string }> } | undefined;
    const toolResults = () => app.seen.flatMap((req) => req.messages.filter((m) => m.role === "tool").map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))));
    const until = async (what: string, fn: () => Promise<boolean> | boolean, ms = 8000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) { if (await fn()) return; await sleep(100); }
      throw new Error(`timed out: ${what}`);
    };
    const card = (text: string) => page.locator(".pa-brd-card", { hasText: text });

    await test("the picker offers a board, and it lands with its panel, asking for a first card", async () => {
      assert.equal((await app.api("POST", `/api/panacea/${s}/open`)).status, 200);
      await page.waitForSelector(".pa-empty");
      await workspaceReady(page);
      await page.getByRole("button", { name: "Retract conversation", exact: true }).click();
      const box = (await page.locator(".pa-board").boundingBox())!;
      await page.mouse.dblclick(box.x + 80, box.y + 80);
      await page.fill(".pa-summon-q", "brainstorm");
      await page.click('.pa-summon [data-recipe="blank.board"]');
      await page.waitForSelector(".pa-surface.is-board .pa-brd");
      await page.waitForSelector(".pa-panel:has(.pa-title:text-is('Board'))");
      assert.match(await page.locator(".pa-surface.is-board .pa-doc-bar").innerText(), /You write[\s\S]*first card/);
      await until("saved, the person's to write", async () => (await board())?.mode === "guide");
    });

    await test("double-click the space and type: a card; Enter keeps it; a second one beside it", async () => {
      const area = (await page.locator(".pa-brd").boundingBox())!;
      await page.mouse.dblclick(area.x + 140, area.y + 80);
      await page.waitForSelector(".pa-brd-card textarea");
      await page.keyboard.type("Mara, a safecracker");
      await page.keyboard.press("Enter");
      await page.mouse.dblclick(area.x + 460, area.y + 260);
      await page.waitForSelector(".pa-brd-card textarea");
      await page.keyboard.type("The vault");
      await page.keyboard.press("Enter");
      await until("two cards on the server", async () => (await board())?.cards.filter((c) => c.text).length === 2);
      assert.equal(await page.locator(".pa-brd-card textarea").count(), 0, "neither is still being written");
    });

    await test("a card dragged moves; dragging from its dot onto another links them, and a line is drawn", async () => {
      const before = (await board())!.cards.find((c) => c.text === "The vault")!;
      const b = (await card("The vault").boundingBox())!;
      await page.mouse.move(b.x + 30, b.y + 20);
      await page.mouse.down();
      await page.mouse.move(b.x + 90, b.y + 60, { steps: 6 });
      await page.mouse.up();
      await until("moved", async () => { const now = (await board())!.cards.find((c) => c.text === "The vault")!; return now.x > before.x + 40 && now.y > before.y + 24; });
      const from = card("Mara");
      await from.hover();
      const dot = (await from.locator(".pa-brd-dot").boundingBox())!;
      const to = (await card("The vault").boundingBox())!;
      await page.mouse.move(dot.x + dot.width / 2, dot.y + dot.height / 2);
      await page.mouse.down();
      await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
      await page.mouse.up();
      await until("linked", async () => (await board())!.links.length === 1);
      await page.waitForSelector(".pa-brd-links line:not(.pa-brd-hit)");
      await shot("board-1-cards");
    });

    await test("the agent asks a question, is refused a card of its own, and the person answers with a linked card", async () => {
      app.script = [
        { tools: [{ name: "panacea_board", args: { ops: [{ op: "ask", text: "Why does Mara need the money?" }] } }] },
        { tools: [{ name: "panacea_board", args: { ops: [{ op: "add", text: "Her brother owes a debt" }] } }] },
        { text: "I put a question on the board." },
      ];
      await app.turn(s, "Help me brainstorm this heist.");
      assert.ok(toolResults().some((r) => /the person's words/.test(r)), "its own card was refused");
      await page.waitForSelector(".pa-brd-card.is-ask:has-text('Why does Mara need the money?')");
      assert.equal(await card("Her brother").count(), 0, "the refused card is nowhere");
      await page.locator(".pa-brd-card.is-ask button", { hasText: "Answer" }).click();
      await page.waitForSelector(".pa-brd-card textarea");
      await page.keyboard.type("Her sister's hospital bill");
      await page.keyboard.press("Enter");
      await until("answered and linked to the question", async () => {
        const b = (await board())!;
        const q = b.cards.find((c) => c.ask);
        const a = b.cards.find((c) => c.text === "Her sister's hospital bill");
        return !!q && !!a && b.links.some((l) => [l.from, l.to].includes(q.id) && [l.from, l.to].includes(a.id));
      });
      await shot("board-2-question");
    });

    await test("Autora writes, once the person says so; Delete takes a selected card away; the panel counts", async () => {
      await page.click(".pa-surface.is-board .pa-doc-mode");
      await until("given to Autora", async () => (await board())?.mode === "agent");
      app.script = [{ tools: [{ name: "panacea_board", args: { ops: [{ op: "add", text: "Getaway: a fishing boat" }] } }] }, { text: "Added." }];
      await app.turn(s, "Add the getaway to the board.");
      await page.waitForSelector(".pa-brd-card:has-text('Getaway: a fishing boat')");
      await card("Getaway").click();
      await page.keyboard.press("Delete");
      await until("taken away", async () => !(await board())!.cards.some((c) => c.text.startsWith("Getaway")));
      const stats = await page.locator(".pa-panel:has(.pa-title:text-is('Board'))").innerText();
      assert.match(stats, /3[\s\S]*Cards/);
      await shot("board-3-done");
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
