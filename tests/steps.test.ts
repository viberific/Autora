/**
 * Folding a turn's commands into one line.
 *
 * A turn that read a dozen files and ran six commands used to be eighteen
 * cards tall, which pushed the answer a screen away from the question. The
 * rule that decides what folds is here; what matters is that nothing is
 * dropped, the order survives, and a run stops at anything that is not a
 * command so a page the agent looked at is not buried among the commands.
 *
 *   npx tsx tests/steps.test.ts
 */
import assert from "node:assert/strict";
import { turnItems, STEP_KINDS } from "../src/lib/steps";
import type { Cell } from "../src/lib/derive";

let passed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}`);
    throw err;
  }
}

/** Only the two fields the rule looks at. */
const cell = (kind: string, seq: number) => ({ kind, seq } as unknown as Cell);
const kinds = (cells: Cell[]) =>
  turnItems(cells).map((item) => (item.kind === "steps" ? `steps(${item.cells.map((c) => c.kind).join("+")})` : item.cell.kind));

test("commands and small tools between two answers become one line", () => {
  const cells = [cell("terminal", 1), cell("tool", 2), cell("terminal", 3)];
  assert.deepEqual(kinds(cells), ["steps(terminal+tool+terminal)"]);
  const items = turnItems(cells);
  assert.equal(items.length, 1);
  assert.deepEqual(items[0].kind === "steps" ? items[0].cells.map((c) => c.seq) : [], [1, 2, 3]);
});

test("anything that is not a command breaks the run", () => {
  const cells = [cell("terminal", 1), cell("screencast", 2), cell("tool", 3)];
  assert.deepEqual(kinds(cells), ["steps(terminal)", "screencast", "steps(tool)"]);
});

test("a single command still folds, so a one-command turn is one line", () => {
  assert.deepEqual(kinds([cell("terminal", 7)]), ["steps(terminal)"]);
});

test("nothing is dropped and the order is kept", () => {
  const cells = [
    cell("terminal", 1), cell("diff", 2), cell("terminal", 3), cell("tool", 4),
    cell("ask", 5), cell("widget", 6), cell("tool", 7),
  ];
  const items = turnItems(cells);
  const seen = items.flatMap((item) => (item.kind === "steps" ? item.cells : [item.cell]));
  assert.deepEqual(seen.map((c) => c.seq), cells.map((c) => c.seq));
  assert.equal(seen.length, cells.length);
});

test("the keys do not move when the same cells are folded again", () => {
  const cells = [cell("terminal", 1), cell("tool", 2), cell("memory", 3)];
  assert.deepEqual(turnItems(cells).map((i) => i.key), turnItems([...cells]).map((i) => i.key));
});

test("an empty turn folds to nothing", () => {
  assert.deepEqual(turnItems([]), []);
});

test("all work activity folds, but questions, permissions and conversation remain actionable", () => {
  for (const kind of ["terminal", "tool", "screen", "file", "files", "images", "widget", "app", "memory", "learned", "chime"]) assert.ok(STEP_KINDS.has(kind));
  for (const kind of ["ask", "permission", "reply", "said", "todo"]) assert.ok(!STEP_KINDS.has(kind));
});

test("questions and permissions nested in browser work cannot be hidden inside contracted activity", () => {
  const question = cell("ask", 3);
  const permission = cell("permission", 4);
  const screen = { kind: "screen", seq: 1, source: "browser", log: [cell("tool", 2), question, permission, cell("terminal", 5)] } as Cell;
  const items = turnItems([screen]);
  assert.deepEqual(items.map((item) => item.kind === "cell" ? item.cell.kind : "activity"), ["activity", "ask", "permission", "activity"]);
  const first = items[0];
  assert.equal(first.kind === "steps" && first.cells[0].kind === "screen" && first.cells[0].log.length, 0, "browser logs are not duplicated");
});

console.log(`${passed} passed`);
