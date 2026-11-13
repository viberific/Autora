/**
 * The floating conversation on a tall desktop screen, in a real browser: pulled taller by its top edge, it stays at the
 * height it was given when the pointer lets go, rather than snapping back to the height of what has been said.
 *
 * Needs a build (npm run build) and a browser.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import { startApp } from "./e2e-harness";
import { CHROME } from "./chrome";

async function main() {
  if (!fs.existsSync(CHROME)) { console.log("  skip  no configured browser here"); return; }
  if (!fs.existsSync(path.join("dist", "index.html"))) { console.log("  skip  no app build here"); return; }
  const app = await startApp();
  const browser = await chromium.launch({ executablePath: CHROME });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 1800 } });
    const session = await app.newSession("Tall chat", "build");
    app.script.push({ text: "A short reply." });
    await app.turn(session, "hello", 60_000);
    await page.goto(`${app.base}/?session=${session}`);
    const flow = page.locator(".conversation-flow.is-float");
    await flow.waitFor();
    await page.waitForTimeout(400);
    const before = (await flow.boundingBox())!;
    const edge = (await flow.locator('.conversation-flow__size[data-edge="n"]').boundingBox())!;
    const x = edge.x + edge.width / 2, y = edge.y + edge.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y - 400, { steps: 8 });
    await page.mouse.move(x, y - 700, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    const after = (await flow.boundingBox())!;
    assert.ok(after.height >= before.height + 600, `the window keeps the height it was pulled to: ${Math.round(before.height)} -> ${Math.round(after.height)}`);
    assert.ok(Math.abs(after.y + after.height - (before.y + before.height)) < 2, "its foot stays where it was");
    // The messages fill the height chosen, so there is no gap between them and the box below.
    const thread = (await flow.locator(".thread").boundingBox())!;
    assert.ok(thread.height > before.height, `the message list grows into it: ${Math.round(thread.height)}`);
    // And a reload keeps it.
    await page.reload();
    await flow.waitFor();
    await page.waitForTimeout(400);
    const reloaded = (await flow.boundingBox())!;
    assert.ok(Math.abs(reloaded.height - after.height) < 2, `a reload keeps the height: ${Math.round(reloaded.height)}`);
    console.log("  ok  a chat pulled taller stays that tall, through a reload");
  } finally {
    await browser.close();
    await app.stop();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
