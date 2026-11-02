/**
 * Stopping the agent, and switching Visible work off, while its hand is at work in Panacea: Stop ends the turn at once
 * (the tool it was waiting on gives way, and is not counted as a failure), the cursor goes, and nothing more is done;
 * switching Visible work off hides the cursor at once and the rest of the work lands straight away (src/lib/handHalt.ts).
 *
 *   npm run build && npx tsx tests/ui-halt.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { chromium } from "playwright-core";
import { sleep, startApp } from "./e2e-harness";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

function browserPath(): string | null {
  if (process.env.AUTORA_BROWSER_PATH) return process.env.AUTORA_BROWSER_PATH;
  for (const dir of fs.existsSync("/opt/pw-browsers") ? fs.readdirSync("/opt/pw-browsers") : []) {
    for (const sub of ["chrome-linux64/chrome", "chrome-linux/chrome"]) {
      const exe = `/opt/pw-browsers/${dir}/${sub}`;
      if (dir.startsWith("chromium-") && fs.existsSync(exe)) return exe;
    }
  }
  return null;
}

async function main() {
  const exe = browserPath();
  if (!exe) { console.log("  skip  no browser here"); return; }
  if (!fs.existsSync("dist/index.html")) { console.log("  skip  the app is not built"); return; }
  const app = await startApp();
  const browser = await chromium.launch({ executablePath: exe });
  try {
    const s = await app.newSession("Halt");
    const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
    await page.goto(`${app.base}/?page=chat&session=${s}`);
    await sleep(2500);
    const long = Array.from({ length: 12 }, (_, i) => `Paragraph ${i} with a fair number of words to type out slowly by hand.`).join("\n\n");
    const pointer = () => page.evaluate(() => document.querySelector(".agent-pointer-layer")?.className ?? "");
    const canvas = async () => (await app.api("GET", `/api/panacea/${s}/doc`)).body.doc as { surfaces: Array<{ title: string; params: { words?: number } }> };

    await test("Stop ends the turn at once while the hand is typing, the cursor goes, and nothing more is typed", async () => {
      app.script.push({ text: "Writing.", tools: [{ name: "panacea_surface", args: { document: long, title: "Long", mode: "agent" } }] });
      app.script.push({ text: "Done." });
      const turn = app.turn(s, "write it", 120_000);
      for (let i = 0; i < 60 && !(await pointer()).includes("is-on"); i++) await sleep(200);
      assert.match(await pointer(), /is-on/, "the hand is at work");
      const at = Date.now();
      await app.api("POST", `/api/sessions/${s}/interrupt`, {});
      const events = await turn;
      assert.ok(Date.now() - at < 3000, `the turn ended ${Date.now() - at} ms after Stop`);
      const err = events.filter((e) => e.kind === "tool.error").pop();
      assert.equal(err?.payload.held, true, "a stopped call is not a failure");
      await sleep(400);
      assert.match(await pointer(), /is-off/, "the cursor went");
      const words = (await canvas()).surfaces.find((x) => x.title === "Long")?.params.words ?? 0;
      await sleep(1500);
      assert.equal((await canvas()).surfaces.find((x) => x.title === "Long")?.params.words ?? 0, words, "nothing more is typed after Stop");
    });

    await test("the stopped call is made again unrefused; switching Visible work off mid-typing hides the cursor at once, and the rest lands", async () => {
      app.script.length = 0;
      app.script.push({ text: "Writing again.", tools: [{ name: "panacea_surface", args: { document: long, title: "Long", mode: "agent" } }] });
      app.script.push({ text: "Done." });
      const turn = app.turn(s, "write it again", 120_000);
      for (let i = 0; i < 60 && !(await pointer()).includes("is-on"); i++) await sleep(200);
      await sleep(1500);
      const at = Date.now();
      await page.evaluate(() => fetch("/api/agent-cursor", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ on: false }) }));
      await sleep(250);
      assert.match(await pointer(), /is-off/, "the cursor went at once");
      await turn;
      assert.ok(Date.now() - at < 5000, `the rest took ${Date.now() - at} ms`);
      const docs = (await canvas()).surfaces.filter((x) => x.title === "Long");
      assert.equal(docs.at(-1)?.params.words, 168, "the whole document landed");
    });
  } finally {
    await browser.close();
    await app.stop();
  }
  console.log(`\n${passed} passed`);
}
await main();
process.exit(0);
