/**
 * Choosing the tests a change can reach (tests/affected.ts), for `npm test -- --changed`.
 *
 *   npx tsx tests/affected.test.ts
 */
import assert from "node:assert/strict";
import path from "node:path";
import { affectedTests } from "./affected";

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}
const root = path.join(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), "..");

console.log("affected tests");

test("a server module reaches the tests that import it, directly or through another module", () => {
  const hit = affectedTests(root, ["server/syntaxcheck.ts"]);
  assert.ok(hit.includes("syntaxcheck.test.ts"), "imports it");
  assert.ok(hit.includes("editfile.test.ts"), "imports editfile, which imports it");
  assert.ok(!hit.includes("todos.test.ts"));
});

test("server.ts reaches the tests that start the app, and only those through it", () => {
  const hit = affectedTests(root, ["server.ts"]);
  assert.ok(hit.includes("e2e-verify.test.ts"));
  assert.ok(!hit.includes("syntaxcheck.test.ts"));
});

test("a changed test is run; a doc reaches nothing", () => {
  assert.deepEqual(affectedTests(root, ["tests/todos.test.ts"]), ["todos.test.ts"]);
  assert.deepEqual(affectedTests(root, ["docs/MAP.md"]), []);
});

console.log(`${passed} passed`);
