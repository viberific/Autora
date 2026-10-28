/**
 * A project's notebook (server/projectbook.ts): every chat in a project folder leaves a line per turn in the folder's
 * notebook, one note per chat, and the notebook comes with the folder when it is pulled into another chat.
 *
 *   npx tsx tests/projectbook.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AUTORA_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "autora-projectbook-"));
const folders = await import("../server/folders");
const { getNotebook } = await import("../server/notebooks");
const { projectNotebook, projectNotebookRefs, recordProjectTurn } = await import("../server/projectbook");

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

const project = folders.createFolder("Launch");

await test("a chat in no project leaves nothing", () => {
  recordProjectTurn("loose-chat", { title: "Loose", request: "hello", reply: "hi", files: [] });
  assert.equal(folders.folderNotebook(project.id), null);
});

await test("the first turn in a project makes its notebook, with a note for the chat", () => {
  folders.setChatFolder("chat-a", project.id);
  recordProjectTurn("chat-a", { title: "Landing page", request: "Make a landing page for the launch", reply: "Done: hero, features and a signup form.", files: ["index.html"], at: Date.UTC(2026, 9, 28) });
  const id = folders.folderNotebook(project.id)!;
  const book = getNotebook(id)!;
  assert.equal(book.title, "Launch: project notes");
  assert.equal(book.entries.length, 1);
  assert.equal(book.entries[0]!.title, "Chat: Landing page");
  assert.equal(book.entries[0]!.text, "- 2026-10-28: Make a landing page for the launch → Done: hero, features and a signup form. [files: index.html]");
});

await test("later turns add lines to the same chat's note, the newest kept; another chat gets its own", () => {
  for (let i = 0; i < 20; i++) recordProjectTurn("chat-a", { title: "Landing page", request: `tweak ${i}`, reply: "ok", files: [] });
  folders.setChatFolder("chat-b", project.id);
  recordProjectTurn("chat-b", { title: "Pricing", request: "Price it at 9 a month", reply: "Set.", files: [], scheduled: true });
  const book = getNotebook(folders.folderNotebook(project.id)!)!;
  assert.equal(book.entries.length, 2);
  const a = book.entries.find((e) => e.title === "Chat: Landing page")!;
  const lines = a.text!.split("\n");
  assert.equal(lines.length, 14);
  assert.match(lines.at(-1)!, /tweak 19/);
  assert.match(book.entries.find((e) => e.title === "Chat: Pricing")!.text!, /\(scheduled\): Price it at 9 a month/);
});

await test("pulling the folder into a chat brings the notebook; a deleted notebook is made again", () => {
  const refs = projectNotebookRefs([project.id]);
  assert.deepEqual(refs.map((r) => r.title), ["Launch: project notes"]);
  folders.setFolderNotebook(project.id, "nb_gone");
  const again = projectNotebook(project.id)!;
  assert.notEqual(again.id, "nb_gone");
  assert.deepEqual(projectNotebookRefs(["fold_000000000000"]), []);
});

console.log(`\n${passed} passed`);
process.exit(0);
