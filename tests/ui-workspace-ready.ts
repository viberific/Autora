import assert from "node:assert/strict";
import type { Page } from "playwright-core";

/** Establish the real scene/entry contract before testing an engine's own controls. */
export async function workspaceReady(page: Page): Promise<void> {
  const workspace = page.getByRole("region", { name: "Panacea workspace", exact: true });
  await workspace.waitFor();
  assert.equal(await workspace.count(), 1, "work belongs to one workspace");
  assert.equal(await page.getByLabel("Panacea work mode").count(), 0, "no exclusive mode combobox");
  assert.equal(await page.getByRole("separator", { name: "Resize the conversation" }).count(), 0, "no left conversation pane");
  assert.equal(await page.getByRole("textbox", { name: "Ask Autora", exact: true }).count(), 1, "engine work keeps the same main entry");
  const navigation = page.getByRole("navigation", { name: "Jump to work", exact: true });
  assert.equal(await navigation.count(), 1);
  assert.ok(await navigation.evaluate((node) => !node.closest(".pa-world")), "work navigation is unscaled viewport chrome");
}

export async function focusWork(page: Page, name: string): Promise<void> {
  await workspaceReady(page);
  await page.getByRole("navigation", { name: "Jump to work", exact: true }).getByRole("button", { name: `Jump to ${name}`, exact: true }).click();
  const retract = page.getByRole("button", { name: "Retract conversation", exact: true });
  if (await retract.count()) await retract.click();
}
