/**
 * A finger scrolling the live browser's picture: the picture moves at once by what the server has not shown yet, one
 * scroll is on its way at a time, and each part is taken back only when a picture from after it is on the screen.
 *
 *   npx tsx tests/scrollahead.test.ts
 */
import assert from "node:assert/strict";
import { LANDED_MS, ScrollAhead } from "../src/lib/scrollAhead";

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ok  ${name}`); } catch (err) { failed++; console.error(`  FAIL ${name}\n`, err); }
}

test("asked-for scroll moves the picture before anything is sent", () => {
  const a = new ScrollAhead();
  a.ask(0, 30);
  a.ask(0, 20);
  assert.deepEqual(a.offset(1280, 800, 0), { dx: 0, dy: 50 });
});

test("one scroll on its way at a time, carrying everything asked for meanwhile", () => {
  const a = new ScrollAhead();
  a.ask(0, 40);
  assert.deepEqual(a.take(), { dx: 0, dy: 40 });
  a.ask(0, 10);
  a.ask(0, 15);
  assert.equal(a.take(), null, "a second one waits for the first");
  assert.deepEqual(a.offset(1280, 800, 0), { dx: 0, dy: 65 });
  a.landed(1000, 0);
  assert.deepEqual(a.take(), { dx: 0, dy: 25 });
});

test("a landed scroll stays until a picture sent after it is shown", () => {
  const a = new ScrollAhead();
  a.ask(0, 100);
  a.take();
  a.landed(1000, 0);
  assert.equal(a.frame(990), false, "an older picture does not show it yet");
  assert.deepEqual(a.offset(1280, 800, 10), { dx: 0, dy: 100 });
  assert.equal(a.frame(1005), true);
  assert.deepEqual(a.offset(1280, 800, 20), { dx: 0, dy: 0 });
});

test("a scroll the server refused is taken back at once", () => {
  const a = new ScrollAhead();
  a.ask(0, 100);
  a.take();
  a.landed(null, 0);
  assert.deepEqual(a.offset(1280, 800, 0), { dx: 0, dy: 0 });
  assert.equal(a.pending(), false);
});

test("with no newer picture (past the page's end) the picture goes back", () => {
  const a = new ScrollAhead();
  a.ask(0, 100);
  a.take();
  a.landed(1000, 0);
  assert.deepEqual(a.offset(1280, 800, LANDED_MS + 1), { dx: 0, dy: 0 });
});

test("the picture is never moved more than most of the view", () => {
  const a = new ScrollAhead();
  a.ask(-5000, 5000);
  const { dx, dy } = a.offset(1280, 800, 0);
  assert.ok(dx >= -1280 && dx < 0 && dy <= 800 && dy > 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
