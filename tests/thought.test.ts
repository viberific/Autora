/**
 * The few words a tool card shows are made from the call itself, short, and only for calls with something to say.
 *
 *   npx tsx tests/thought.test.ts
 */
import assert from "node:assert/strict";
import { MAX, thoughtForTool } from "../src/lib/thought";

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

test("an act with nothing to say has no thought, rather than a made-up one", () => {
  assert.equal(thoughtForTool("memory_write", { title: "x" }), null);
  assert.equal(thoughtForTool("todo", {}), null);
  assert.equal(thoughtForTool("agents", {}), null);
});

test("tools in the windows say what they are doing, with the one detail that is true", () => {
  assert.equal(thoughtForTool("office_edit", { ops: [{}, {}, {}] }), "Making 3 changes");
  assert.equal(thoughtForTool("office_edit", { ops: [{}] }), "Making a change");
  assert.equal(thoughtForTool("pdf_look", { pages: 4 }), "Looking at page 4");
  assert.equal(thoughtForTool("browser_fill", { values: [{}, {}] }), "Filling in 2 fields");
  assert.equal(thoughtForTool("terminal", { command: "npm test\nrm x" }), "Running “npm test”");
  assert.equal(thoughtForTool("video_ui", { label: "Export" }), "Using “Export”");
  assert.equal(thoughtForTool("photo_edit", {}), "Editing the picture");
  assert.equal(thoughtForTool("studio_notes", {}), "Writing notes");
});

test("every thought is short enough to read at a glance", () => {
  const long = "x".repeat(200);
  for (const t of [
    thoughtForTool("web_search", { query: long }), thoughtForTool("terminal", { command: long }), thoughtForTool("video_ui", { label: long }),
  ]) assert.ok(t && t.length <= MAX + 12, `${t?.length}: ${t}`);
});

console.log(`${passed} passed`);
