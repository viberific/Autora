/**
 * Overlap analysis: which calls made at the same time may run together.
 *
 *   npx tsx tests/overlap.test.ts
 */
import assert from "node:assert/strict";
import { conflict, footprint, pathsIn, plan, planCalls, planTasks } from "../server/overlap";

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

test("files named in a task are found, and web addresses and abbreviations are not", () => {
  assert.deepEqual(pathsIn("Fix src/app.ts and ./docs/MAP.md, e.g. the README.md. See https://example.com/a.html").sort(), ["docs/map.md", "readme.md", "src/app.ts"]);
});

test("looking calls run together", () => {
  const batches = planCalls([
    { name: "http_request", args: { url: "https://a.test" } },
    { name: "research", args: { question: "x" } },
    { name: "pdf_look", args: {} },
  ]);
  assert.deepEqual(batches, [[0, 1, 2]]);
});

test("a shell, a page or an edit always runs alone, in the order it was made", () => {
  const batches = planCalls([
    { name: "research", args: {} },
    { name: "terminal", args: { command: "ls" } },
    { name: "research", args: {} },
    { name: "edit_file", args: { path: "a.ts" } },
    { name: "browser_click", args: {} },
  ]);
  assert.deepEqual(batches, [[0], [1], [2], [3], [4]]);
});

test("a call that is not understood is treated as changing everything", () => {
  assert.notEqual(conflict(footprint("some_new_tool", {}), footprint("research", {})), null);
});

test("a window is read together but not opened while it is read", () => {
  assert.deepEqual(planCalls([{ name: "photo_look" }, { name: "photo_info" }]), [[0, 1]]);
  assert.deepEqual(planCalls([{ name: "photo_look" }, { name: "photo_open", args: { file: "a.png" } }]), [[0], [1]]);
});

test("a call never overtakes an earlier one it conflicts with", () => {
  const a = { reads: ["world"], writes: [] };
  const w = { reads: [], writes: ["file:x"] };
  assert.deepEqual(plan([a, w, a]), [[0], [1], [2]]);
});

test("tasks for different agents on different files start together", () => {
  const { batches, held } = planTasks([
    { agent: "Pella", task: "Write src/a.ts" },
    { agent: "Quill", task: "Write src/b.ts" },
  ]);
  assert.deepEqual(batches, [[0, 1]]);
  assert.equal(held.size, 0);
});

test("tasks that name the same file, or a folder holding it, wait for each other", () => {
  const same = planTasks([{ agent: "Pella", task: "Rewrite src/a.ts" }, { agent: "Quill", task: "Add tests for src/a.ts" }]);
  assert.deepEqual(same.batches, [[0], [1]]);
  assert.match(same.held.get(1) ?? "", /Pella/);
  const folder = planTasks([{ agent: "Pella", task: "Tidy everything in src" }, { agent: "Quill", task: "Edit src/b.ts" }]);
  assert.deepEqual(folder.batches, [[0, 1]], "a bare word is not a path");
  const dir = planTasks([{ agent: "Pella", task: "Tidy ./src/lib/" }, { agent: "Quill", task: "Edit src/lib/b.ts" }]);
  assert.deepEqual(dir.batches, [[0], [1]]);
});

test("the same agent is not started twice at once", () => {
  assert.deepEqual(planTasks([{ agent: "Pella", task: "one" }, { agent: "pella", task: "two" }]).batches, [[0], [1]]);
});

console.log(`${passed} passed`);
