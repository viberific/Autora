import assert from "node:assert/strict";
import type { Page } from "playwright-core";

/**
 * Establish the real scene/entry contract before testing an engine's own controls. On a blank canvas (`blank`) there is no
 * work to move around, so there are no navigation controls either: controls appear when the work needs them (CLAUDE.md).
 */
export async function workspaceReady(page: Page, options: { blank?: boolean } = {}): Promise<void> {
  const workspace = page.getByRole("region", { name: "Panacea workspace", exact: true });
  await workspace.waitFor();
  assert.equal(await workspace.count(), 1, "work belongs to one workspace");
  assert.equal(await page.getByLabel("Panacea work mode").count(), 0, "no exclusive mode combobox");
  assert.equal(await page.getByRole("separator", { name: "Resize the conversation" }).count(), 0, "no left conversation pane");
  assert.equal(await page.getByRole("textbox", { name: "Ask Autora", exact: true }).count(), 1, "engine work keeps the same main entry");
  const navigation = page.getByRole("navigation", { name: "Jump to work", exact: true });
  if (options.blank) {
    assert.equal(await navigation.count(), 0, "a blank canvas has no controls for moving around work");
    return;
  }
  assert.equal(await navigation.count(), 1);
  assert.ok(await navigation.evaluate((node) => !node.closest(".pa-world")), "work navigation is unscaled viewport chrome");
}

/**
 * A phone folds the work buttons (jump to a piece of work, zoom out, show all) into one small button until they are
 * wanted, and folds them away again a moment after one is used. This opens them; on a desktop they are always there.
 */
export async function openWorkButtons(page: Page): Promise<void> {
  const toggle = page.getByRole("button", { name: "Show the work buttons", exact: true });
  if (!(await toggle.count())) return;
  await toggle.click();
  // They arrive with a short motion; what is measured or pressed next is at rest.
  await page.waitForTimeout(350);
}

export async function focusWork(page: Page, name: string): Promise<void> {
  await workspaceReady(page);
  await openWorkButtons(page);
  await page.getByRole("navigation", { name: "Jump to work", exact: true }).getByRole("button", { name: `Jump to ${name}`, exact: true }).click();
  await shrinkConversation(page);
}

/**
 * Gives a desktop's world as much room as the conversation can: its floating window is made as small as it goes and put
 * back at the foot of the world, by keyboard, the way a person could. A phone has no window, so nothing changes there.
 */
export async function shrinkConversation(page: Page): Promise<void> {
  const corner = page.getByRole("separator", { name: "Resize conversation", exact: true });
  if (!(await corner.count())) return;
  // The pull is the window's top-right corner: down is shorter, left is narrower. Its foot stays where it was.
  for (let i = 0; i < 16; i += 1) await corner.press("Shift+ArrowDown");
  for (let i = 0; i < 4; i += 1) await corner.press("Shift+ArrowLeft");
  await page.getByRole("button", { name: "Move conversation", exact: true }).press("Home");
}
