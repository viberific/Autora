/**
 * What a person reads in the thread without opening anything, and what the app holds back without calling it a failure
 * (docs/TRY-IT-2026-11-11-PANACEA.md, P2-1 and P2-2).
 *
 *   npx tsx tests/panacea-rest.test.ts
 */
import assert from "node:assert/strict";
import { describeArgs, heldWords, stepWords } from "../src/components/ToolCell";
import { derive } from "../src/lib/derive";
import type { AutoraEvent } from "../src/lib/types";

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

test("a folded step reads as what it did, never as key=value", () => {
  const lines = [
    stepWords("panacea_surface", { csv: "Month,Region\n2025-07,EU", title: "Sales" }),
    stepWords("panacea_surface", { document: "# Notes", mode: "agent" }),
    stepWords("panacea_board", { ops: [{ op: "ask", text: "Who?" }] }),
    stepWords("todo", { done: [1], start: 2 }),
    stepWords("photo_open", { new: { width: 800, height: 600 } }),
    stepWords("office_create", { type: "pptx", name: "Pitch", spec: { pages: [] } }),
    stepWords("some_new_tool", { alpha: 1, beta: [1, 2] }),
  ];
  for (const line of lines) assert.ok(!/=/.test(line) && !/[{[]/.test(line), `plumbing in "${line}"`);
  assert.equal(lines[0], "Putting a table on the canvas");
  assert.equal(lines[1], "Starting a page");
  assert.equal(lines[3], "ticked 1 task");
  assert.equal(lines[5], "Starting a presentation");
  assert.equal(lines[6], "Some new tool");
});

test("what a call is about is still its line: a command, a page, a search", () => {
  assert.equal(stepWords("read_file", { path: "src/App.tsx" }), "src/App.tsx");
  assert.equal(stepWords("set_mode", { to: "build", reason: "plan is on the list" }), "switch to build");
  // The opened record keeps the exact call.
  assert.equal(describeArgs({ alpha: 1, beta: [1, 2] }), "alpha=1 beta=2 items");
});

const ev = (seq: number, kind: string, payload: Record<string, unknown>, span: string | null = null): AutoraEvent =>
  ({ seq, kind, actor: "agent", span, payload, blob: null, ts: seq } as unknown as AutoraEvent);

test("a step the app held back is not a failure: planning, the person's words, something they are using", () => {
  const events = [
    ev(1, "turn.user", { text: "go" }),
    ev(2, "tool.call", { name: "panacea_doc", args: {} }, "a"), ev(3, "tool.error", { held: true, planning: true, error: "Not run: planning changes nothing." }, "a"),
    ev(4, "tool.call", { name: "panacea_board", args: {} }, "b"), ev(5, "tool.error", { held: true, theirs: true, error: "writes the person's words" }, "b"),
    ev(6, "tool.call", { name: "pdf_edit", args: {} }, "c"), ev(7, "tool.error", { held: true, error: "Not done: the person is working on this." }, "c"),
    ev(8, "tool.call", { name: "terminal", args: {} }, "d"), ev(9, "tool.error", { denied: true, reason: "The person declined this." }, "d"),
    ev(10, "tool.call", { name: "office_create", args: {} }, "e"), ev(11, "tool.error", { error: "no valid pages" }, "e"),
  ];
  const spans = derive(events).spansById;
  assert.deepEqual([spans.get("a")!.status, spans.get("a")!.held], ["denied", "planning"]);
  assert.deepEqual([spans.get("b")!.status, spans.get("b")!.held], ["denied", "theirs"]);
  assert.deepEqual([spans.get("c")!.status, spans.get("c")!.held], ["denied", "busy"]);
  assert.deepEqual([spans.get("d")!.status, spans.get("d")!.held], ["denied", undefined]);
  assert.deepEqual([spans.get("e")!.status, spans.get("e")!.held], ["error", undefined]);
  assert.deepEqual(["planning", "theirs", "busy", undefined].map((h) => heldWords(h as never)), ["planning first", "yours to write", "waited for you", "declined"]);
});

console.log(`\n${passed} panacea-rest tests passed`);
