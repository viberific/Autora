/**
 * What the person has picked in the PDF, Video and Photo windows reaches the agent's briefing for a couple of minutes,
 * like the Office windows' (tests/officedesk.test.ts): the shared limits, and the PDF frame's wording of a selection.
 *
 *   npx tsx tests/picked.test.ts
 */
import assert from "node:assert/strict";
import { PICK_FRESH_MS, PICK_MAX, pickText, rememberPick, tidyPick } from "../server/picked";
import { pickWords } from "../spectra-editor/src/autora/rail-need";

function test(name: string, fn: () => void) {
  try { fn(); console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

test("a pick is tidied and cut to 120 characters", () => {
  assert.equal(tidyPick("  the   quarterly\n numbers "), "the quarterly numbers");
  assert.equal(tidyPick("x".repeat(500)).length, PICK_MAX);
  assert.equal(tidyPick(undefined), "");
});

test("an empty pick is nothing to keep", () => {
  assert.equal(rememberPick("   "), undefined);
  assert.deepEqual(rememberPick("a layer", 5), { text: "a layer", at: 5 });
});

test("a pick is told while fresh and not after two minutes", () => {
  const p = rememberPick("this clip", 1000);
  assert.equal(pickText(p, 1000 + PICK_FRESH_MS - 1), "this clip");
  assert.equal(pickText(p, 1000 + PICK_FRESH_MS), null);
  assert.equal(pickText(undefined), null);
});

test("the PDF frame words a selection with its page", () => {
  assert.equal(pickWords("  Tenant   signature: ", 2), '"Tenant signature:" (page 2)');
  assert.equal(pickWords("word", null), '"word"');
  assert.equal(pickWords("   ", 3), "");
  assert.ok(pickWords("y".repeat(400), 1).length < 140);
});

console.log("picked tests passed");
