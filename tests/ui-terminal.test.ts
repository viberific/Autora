/** Per-command collapsible chat output, on desktop and phone. Requires the built app and Chromium. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import { startApp } from "./e2e-harness";

async function main() {
  const exe = process.env.AUTORA_BROWSER_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
  if (!exe || !fs.existsSync(exe)) { console.log("  skip  no configured browser here"); return; }
  if (!fs.existsSync(path.join("dist", "index.html"))) { console.log("  skip  no app build here"); return; }
  const app = await startApp();
  const browser = await chromium.launch({ executablePath: exe });
  const page = await browser.newPage({ viewport: { width: 1360, height: 820 } });
  let passed = 0;
  try {
    const session = await app.newSession("Commands", "build");
    await page.goto(`${app.base}/?session=${session}`);
    app.script.push({ tools: [{ name: "panacea_surface", args: { document: "# Work area", title: "Work area" } }] });
    app.script.push({ text: "Ready." });
    await app.turn(session, "open my work");
    const run = async (command: string) => {
      const before = await page.locator(".thread .steps").count();
      app.script.push({ tools: [{ name: "terminal", args: { command } }] });
      app.script.push({ text: "Done." });
      await app.turn(session, "run the command");
      await page.waitForFunction((count) => document.querySelectorAll(".thread .steps").length > count, before);
      const group = page.locator(".thread .steps").last();
      assert.equal(await group.locator(".steps-top").getAttribute("aria-expanded"), "false", "completed/error work is contracted by default");
      await group.locator(".steps-top").click();
      const card = group.locator(".cell.term").last();
      await card.waitFor();
      return card;
    };

    for (const viewport of [{ width: 1360, height: 820 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      const card = await run('node -e "console.log(\'short-command-output\')"');
      const toggle = card.getByRole("button", { name: /Show output|Hide output/ });
      if (await toggle.getAttribute("aria-expanded") === "true") await toggle.click();
      assert.equal(await toggle.getAttribute("aria-expanded"), "false");
      assert.equal(await card.locator(".term-body").isVisible(), false);
      await toggle.click();
      try { await card.getByText("short-command-output", { exact: true }).waitFor({ timeout: 5000 }); }
      catch { throw new Error(`The command card did not show its output: ${await card.innerText()}`); }
      assert.equal(await toggle.getAttribute("aria-expanded"), "true");
      assert.equal(await card.getByRole("button", { name: /copy/i }).count(), 1);
      assert.equal(await page.locator(".tm-window").count(), 0);
      assert.equal(await page.locator(".panacea-workspace .cell.term").count(), 0, "commands are not duplicated in Activity");
      passed += 1;
    }

    const failure = await run('node -e "console.log(\'command-failed\'); process.exit(3)"');
    await failure.getByText("exit 3").waitFor();
    assert.equal(await failure.getByRole("button", { name: "Show output" }).getAttribute("aria-expanded"), "false");
    assert.equal(await failure.locator(".term-body").isVisible(), false);
    passed += 1;

    const empty = await run('node -e ""');
    const toggle = empty.getByRole("button", { name: /Show output|Hide output/ });
    assert.equal(await toggle.count(), 1);
    if (await toggle.getAttribute("aria-expanded") === "false") await toggle.click();
    await empty.getByText("no output", { exact: true }).waitFor();
    passed += 1;
    const beforeLive = await page.locator(".thread .steps").count();
    app.script.push({ tools: [{ name: "terminal", args: { command: 'node -e "let i=0;const t=setInterval(()=>{console.log(\'stream-\'+i);if(++i===10)clearInterval(t)},400)"' } }] });
    app.script.push({ text: "Stream complete." });
    const liveTurn = app.turn(session, "stream the output");
    await page.waitForFunction((count) => document.querySelectorAll(".thread .steps").length > count, beforeLive);
    const liveGroup = page.locator(".thread .steps").last();
    assert.equal(await liveGroup.locator(".steps-top").getAttribute("aria-expanded"), "false", "live activity is contracted by default");
    await liveGroup.locator(".steps-top").click();
    const liveCard = liveGroup.locator(".cell.term");
    await liveCard.getByRole("button", { name: "Show output", exact: true }).click();
    await liveCard.getByText("stream-0", { exact: true }).waitFor();
    await liveTurn;
    await liveCard.getByText("stream-9", { exact: true }).waitFor();
    assert.equal(await page.locator(".pw-scene-stack .cell.term").count(), 0, "streaming output is not duplicated on the board");
    passed += 1;
    console.log(`\n${passed} passed`);
  } finally {
    await browser.close();
    await app.stop();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
