/** One real spatial scene on desktop and phone; root Music/native engines need no embedded editor build. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import { startApp } from "./e2e-harness";

async function main() {
  const exe = process.env.AUTORA_BROWSER_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
  if (!fs.existsSync(exe)) { console.log("  skip  no configured browser here"); return; }
  if (!fs.existsSync(path.join("dist", "index.html"))) { console.log("  skip  no app build here"); return; }
  const app = await startApp();
  const browser = await chromium.launch({ executablePath: exe });
  const page = await browser.newPage();
  let passed = 0;
  try {
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      const session = await app.newSession("Spatial workspace", "build");
      await page.goto(`${app.base}/?session=${session}`);
      await page.getByRole("button", { name: "Open Panacea", exact: true }).press("Enter");
      const chooser = page.getByRole("dialog", { name: "Panacea capabilities" });
      await chooser.waitFor();
      await chooser.getByRole("button", { name: /Canvas/ }).click();
      const workspace = page.getByRole("region", { name: "Panacea workspace", exact: true });
      await workspace.waitFor();
      const dock = page.getByRole("navigation", { name: "Jump to work" });
      await dock.waitFor();
      assert.equal(await dock.count(), 1, "the jump dock is outside the transformed world, not copied into each surface");
      assert.equal(await workspace.getByRole("combobox").count(), 0, "no replacement tab/mode selector");
      await app.api("POST", `/api/studio/${session}/open`);
      const music = workspace.locator('[data-engine="studio"]');
      await music.waitFor();
      const jump = dock.getByRole("button", { name: "Jump to Music", exact: true });
      const first = await jump.boundingBox();
      await page.waitForTimeout(250);
      const last = await jump.boundingBox();
      assert.ok(first && last && Math.abs(first.x - last.x) < 1 && Math.abs(first.y - last.y) < 1, "jump controls do not move with the camera");
      await dock.getByRole("button", { name: "Jump to Music", exact: true }).click();
      const name = music.getByRole("textbox", { name: "Song name", exact: true });
      await name.fill("My work remains in the scene");
      await name.press("Tab");
      await music.evaluate((node) => node.setAttribute("data-kept-work", "yes"));
      app.script.push({ tools: [
        { name: "todo", args: { todos: ["Review the notes", "Arrange the music"] } },
        { name: "panacea_surface", args: { document: "# Project notes\n\nThe design stays yours.", title: "Project notes" } },
      ] });
      app.script.push({ text: "The notes are ready." });
      await app.turn(session, "open my project notes");
      const thread = page.locator(".conversation-flow .thread");
      await thread.evaluate((node) => node.setAttribute("data-history-kept", "yes"));
      const todo = page.locator(".conversation-flow__todos .todo-dock");
      await todo.waitFor();
      await page.getByRole("button", { name: "Retract conversation", exact: true }).click();
      assert.equal(await thread.getAttribute("data-history-kept"), "yes", "retract keeps the original history viewport mounted");
      assert.equal(await todo.isVisible(), true, "TODO stays attached to the entry when chat retracts");
      await page.getByRole("button", { name: "Show conversation", exact: true }).click();
      assert.equal(await page.getByRole("textbox", { name: "Ask Autora", exact: true }).count(), 1, "there is only one main entry");
      assert.equal(await page.getByRole("separator", { name: "Resize the conversation" }).count(), 0, "there is no left chat allocation");
      assert.equal(await workspace.locator('[data-engine="work"]').count(), 0, "activity is contracted in conversation, not a world card");
      for (const header of await page.locator(".conversation-flow .steps-top").all()) assert.equal(await header.getAttribute("aria-expanded"), "false");
      const documentCard = workspace.locator(".pa-surface.is-doc");
      await documentCard.waitFor();
      await dock.getByRole("button", { name: "Show all work", exact: true }).click();
      const allVisible = await workspace.locator(".pa-board").evaluate((node) => {
        const view = node.getBoundingClientRect();
        return Array.from(node.querySelectorAll(".pa-surface,.pw-engine")).every((work) => {
          const rect = work.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && rect.left >= view.left - 1 && rect.right <= view.right + 1 &&
            rect.top >= view.top - 1 && rect.bottom <= view.bottom - 75;
        });
      });
      assert.ok(allVisible, "Show all fits native work and hosted engines in one camera");
      await dock.getByRole("button", { name: "Jump to Project notes", exact: true }).click();
      await page.getByRole("button", { name: "Retract conversation", exact: true }).click();
      assert.equal(await music.getAttribute("data-kept-work"), "yes", "jumping did not reconstruct the engine");
      assert.equal(await music.getAttribute("hidden"), null, "work is never hidden by a jump");
      const editor = documentCard.locator(".ProseMirror");
      await editor.click();
      const camera = await workspace.locator(".pa-world").getAttribute("style");
      await editor.press("Control+End");
      await editor.press("Enter");
      await editor.pressSequentially("My own creative decision.");
      await page.waitForTimeout(600);
      assert.equal(await workspace.locator(".pa-world").getAttribute("style"), camera, "typing cannot shift the camera");
      const words = await editor.innerText();
      await dock.getByRole("button", { name: "Jump to Music", exact: true }).click();
      assert.equal(await name.inputValue(), "My work remains in the scene");
      await dock.getByRole("button", { name: "Jump to Project notes", exact: true }).click();
      assert.equal(await editor.innerText(), words, "the native document stayed mounted");
      const ask = page.getByRole("textbox", { name: "Ask Autora", exact: true });
      await ask.fill("Suggest two ways to organize these notes");
      assert.equal(await ask.inputValue(), "Suggest two ways to organize these notes");
      await dock.getByRole("button", { name: "Zoom out", exact: true }).click();
      await dock.getByRole("button", { name: "Show all work", exact: true }).click();
      assert.equal(await music.getAttribute("data-kept-work"), "yes");
      const caps = workspace.getByRole("button", { name: "Capabilities", exact: true });
      await caps.click();
      const capabilityDialog = page.getByRole("dialog", { name: "Panacea capabilities" });
      await capabilityDialog.waitFor();
      const unscaled = await capabilityDialog.evaluate((node) => !node.closest(".pa-world") && node.getBoundingClientRect().width > 250);
      assert.ok(unscaled, "the capability dialog is viewport-level even at scene overview zoom");
      await page.keyboard.press("Escape");
      await capabilityDialog.waitFor({ state: "hidden" });
      assert.ok(await caps.evaluate((node) => document.activeElement === node), "Escape restores the capability trigger");
      const load = workspace.locator(".pa-window > .pdf-bar").getByRole("button", { name: "Load", exact: true });
      await load.click();
      const fileDialog = page.getByRole("dialog");
      await fileDialog.waitFor();
      assert.ok(await fileDialog.evaluate((node) => !node.closest(".pa-world")), "Load opens a viewport portal, not a scaled scene modal");
      await page.keyboard.press("Escape");
      await fileDialog.waitFor({ state: "hidden" });
      assert.ok(await load.evaluate((node) => document.activeElement === node), "Escape restores the Load trigger");
      await caps.click();
      const flowPicker = page.getByRole("dialog", { name: "Panacea capabilities" });
      await flowPicker.getByRole("button", { name: /Flowchart/ }).click();
      await flowPicker.waitFor({ state: "hidden" });
      const native = (await app.api("GET", `/api/panacea/${session}/doc`)).body as { doc: { surfaces: Array<{ kind: string; board?: { diagram?: string; mode?: string } }> } };
      assert.ok(native.doc.surfaces.some((surface) => surface.kind === "board" && surface.board?.diagram === "flowchart" && surface.board.mode === "guide"), "person entry creates a real native flowchart in guide mode without a model call");
      passed += 1;
    }
    console.log(`\n${passed} passed`);
  } finally {
    await browser.close();
    await app.stop();
  }
}
main().catch((err) => { console.error(err); process.exit(1); });
