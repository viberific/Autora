/**
 * Learn mode in the page (docs/LEARN.md): the header has the switch; a lesson rings the real control it names and waits for
 * the person to use it; a step with no control to ring says so in words and moves on with Next; a control that is not on
 * screen gets no ring; Skip and the cross let the person leave; switching Learn off clears it.
 *
 *   npm run build && npx tsx tests/ui-learn.test.ts
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
    const s = await app.newSession("Learn", "build");
    const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
    await page.goto(`${app.base}/?page=chat&session=${s}`);
    await page.waitForSelector(".learn-toggle");
    const ring = () => page.locator(".learn-ring");
    const card = () => page.locator(".learn-card");

    await test("Learn starts off, and the header switch turns it on for this chat", async () => {
      assert.equal(await page.getAttribute(".learn-toggle", "aria-pressed"), "false");
      await page.click(".learn-toggle");
      await page.waitForFunction(() => document.querySelector(".learn-toggle")?.getAttribute("aria-pressed") === "true");
      await sleep(300);
      assert.equal((await app.api("GET", "/api/sessions")).body.find((x: any) => x.id === s).learn, true);
    });

    await test("a lesson rings the control it names, and using that control moves it to the next step", async () => {
      app.script.push({ tools: [{ name: "learn_show", args: { title: "Switching chats", steps: [
        { say: "Open the chat list.", target: { label: "Switch session" } },
        { say: "Pick the chat you want.", target: { label: "Not a control on this page" } },
        { say: "That is all.", },
      ] } }] });
      app.script.push({ text: "Start with the chat list." });
      await app.turn(s, "show me how to switch chats");
      await ring().waitFor();
      assert.match((await card().innerText()), /Switching chats[\s\S]*1 of 3[\s\S]*Open the chat list/);
      const target = await page.locator(".session-btn").boundingBox();
      const at = (await ring().boundingBox())!;
      assert.ok(Math.abs(at.x - (target!.x - 4)) < 3 && Math.abs(at.width - (target!.width + 8)) < 3, "the ring is on the control");
      assert.equal(await page.locator(".learn-next").count(), 0, "no Next while the control is there to use");
      await page.click(".session-btn");
      await page.waitForFunction(() => /2 of 3/.test(document.querySelector(".learn-card")?.textContent ?? ""));
    });

    await test("a control that is not on screen gets no ring: the card says it in words and Next moves on", async () => {
      assert.equal(await ring().count(), 0);
      assert.match(await card().innerText(), /Pick the chat you want/);
      await page.click(".learn-next");
      await page.waitForFunction(() => /3 of 3/.test(document.querySelector(".learn-card")?.textContent ?? ""));
      await page.click(".learn-next");
      await page.waitForFunction(() => !document.querySelector(".learn-card"));
      await sleep(300);
      assert.equal(await card().count(), 0, "the lesson is over");
    });

    await test("Do this one for me asks the agent; the cross leaves the lesson; switching Learn off clears it", async () => {
      await page.keyboard.press("Escape"); // the chat list the first lesson opened
      await page.waitForFunction(() => !document.querySelector(".scrim"));
      app.script.push({ tools: [{ name: "learn_show", args: { title: "Again", steps: [{ say: "Open the chat list.", target: { label: "Switch session" } }, { say: "Two." }] } }] });
      app.script.push({ text: "Go." });
      await app.turn(s, "show me how again");
      await card().waitFor();
      app.script.push({ text: "Done for you." });
      await page.click("text=Do this one for me");
      await app.until(s, (e) => e.some((x) => x.kind === "turn.user" && /Do this step for me: Open the chat list/.test(x.payload.text ?? "")), "the request reached the agent");
      await page.waitForFunction(() => /2 of 2/.test(document.querySelector(".learn-card")?.textContent ?? ""));
      await page.click(".learn-x");
      await page.waitForFunction(() => !document.querySelector(".learn-card"));
      app.script.push({ tools: [{ name: "learn_show", args: { title: "Third", steps: [{ say: "One." }, { say: "Two." }] } }] });
      app.script.push({ text: "Go." });
      await app.turn(s, "show me how once more");
      await card().waitFor();
      await page.click(".learn-toggle");
      await page.waitForFunction(() => !document.querySelector(".learn-card"));
    });
  } finally {
    await browser.close();
    await app.stop();
  }
  console.log(`\n${passed} passed, 0 failed`);
}

main().catch((err) => { console.error(err); process.exit(1); });
