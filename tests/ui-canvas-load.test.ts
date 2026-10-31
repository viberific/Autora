/** Clean mounts distinguish valid doc+rev, malformed JSON/schema, and recovery without discarding saved work. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import { newCanvas } from "../src/lib/panacea/canvas";
import { startApp } from "./e2e-harness";

async function main() {
  const exe = process.env.AUTORA_BROWSER_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
  if (!fs.existsSync(exe) || !fs.existsSync(path.join("dist", "index.html"))) { console.log("  skip  browser/build unavailable"); return; }
  const app = await startApp();
  const browser = await chromium.launch({ executablePath: exe });
  try {
    const session = await app.newSession("Canvas response", "build");
    await app.api("POST", `/api/panacea/${session}/open`);
    const saved = newCanvas("Saved native work");
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let mode: "valid" | "schema" | "html" = "valid";
    await page.route(`**/api/panacea/${session}/doc`, async (route) => {
      await route.fulfill({
        status: 200, contentType: mode === "html" ? "text/html" : "application/json",
        body: mode === "html" ? "<html>Wrong response</html>" : JSON.stringify(mode === "valid" ? { doc: saved, rev: 0 } : { doc: { panels: {}, surfaces: [] }, rev: 0 }),
      });
    });
    await page.goto(`${app.base}/?session=${session}`);
    const name = page.getByRole("textbox", { name: "Canvas name", exact: true });
    await name.waitFor();
    await page.waitForFunction(() => (document.querySelector('[aria-label="Canvas name"]') as HTMLInputElement | null)?.value === "Saved native work");
    assert.equal(await name.isEnabled(), true);
    assert.equal(await page.getByText(/The canvas could not be loaded:/).count(), 0);
    mode = "schema";
    await page.reload();
    await page.getByText(/does not contain a valid native canvas document/).waitFor();
    assert.equal(await name.isDisabled(), true);
    assert.equal(await page.getByRole("button", { name: "Save native work", exact: true }).isDisabled(), true);
    mode = "html";
    await page.reload();
    await page.getByText(/workspace returned invalid JSON/).waitFor();
    mode = "valid";
    await page.reload();
    await page.waitForFunction(() => (document.querySelector('[aria-label="Canvas name"]') as HTMLInputElement | null)?.value === "Saved native work");
    assert.equal(await page.getByText(/The canvas could not be loaded:/).count(), 0);
    assert.deepEqual(errors, [], "clean mounts must not change hook order or inherit HMR queues");
    console.log("  ok  valid doc+rev loads; malformed 200 is explicit; clean recovery preserves saved work");
    await page.close();
  } finally { await browser.close(); await app.stop(); }
}
main().catch((error) => { console.error(error); process.exit(1); });
