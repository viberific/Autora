/**
 * A document's operation log: steps with their inverses, who made them, typing joined into one step, and one step taken
 * out on its own with the later ones kept.
 *
 *   npx tsx tests/panacea-doclog.test.ts
 */
import assert from "node:assert/strict";
import { TextSelection } from "prosemirror-state";
import { blocksOf, createDoc, formatBlock, replaceBlockText, stateOf, plainText } from "../src/lib/panacea/document";
import { MAX_OPS, TYPING_MS, listOps, readLog, record, stepBetween, undoOp, type DocLog } from "../src/lib/panacea/doclog";

function test(name: string, fn: () => void) {
  try { fn(); console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

const start = () => stateOf(createDoc("# Plan\n\nWe start small.\n\nThen we grow.\n"));
const idOf = (s: ReturnType<typeof start>, needle: string) => blocksOf(s.doc).find((b) => b.text.includes(needle))!.id;
const ok = <T>(r: T | string): T => { assert.ok(typeof r !== "string", String(r)); return r as T; };

test("a step turns one document into the other, and its inverse puts it back", () => {
  const a = start();
  const b = ok(replaceBlockText(a, idOf(a, "start small"), "We start very small."));
  const made = stepBetween(a.doc, b.doc)!;
  assert.ok(made.step.apply(a.doc).doc!.eq(b.doc));
  assert.ok(made.inverse.apply(b.doc).doc!.eq(a.doc));
  assert.equal(stepBetween(a.doc, a.doc), null, "no change, no step");
});

test("a log records who and what, in order, and a person's typing joins into one step", () => {
  const a = start();
  const b = ok(formatBlock(a, idOf(a, "Then we"), "block", "h2"));
  let log: DocLog = record(undefined, a.doc, b.doc, "agent", "made a heading", 1000);
  const c = ok(replaceBlockText(b, idOf(b, "start small"), "We start s"));
  log = record(log, b.doc, c.doc, "person", "", 2000);
  const d = ok(replaceBlockText(c, idOf(c, "start s"), "We start small and"));
  log = record(log, c.doc, d.doc, "person", "", 2000 + 1000);
  assert.deepEqual(log.ops.map((o) => `${o.n}:${o.who}`), ["1:agent", "2:person"], "the second typing joined the first");
  assert.match(log.ops[1]!.summary, /word|reworded/);
  const e = ok(replaceBlockText(d, idOf(d, "start small"), "We start small and then"));
  const apart = record(log, d.doc, e.doc, "person", "", 3000 + TYPING_MS + 1);
  assert.equal(apart.ops.length, 3, "after a pause it is a new step");
  assert.deepEqual(listOps(apart).map((o) => Object.keys(o).sort().join()), ["at,n,summary,who", "at,n,summary,who", "at,n,summary,who"], "the page gets no steps");
});

test("one step can be taken out on its own and the later ones stay", () => {
  const a = start();
  const b = ok(formatBlock(a, idOf(a, "Then we"), "block", "h2")); // the agent formats the last line
  let log = record(undefined, a.doc, b.doc, "agent", "formatted", 1);
  const c = ok(replaceBlockText(b, idOf(b, "start small"), "We start with care.")); // the person rewrites the other line
  log = record(log, b.doc, c.doc, "person", "rewrote", 10_000);
  const out = undoOp(c.doc, log, 1);
  assert.ok("doc" in out, JSON.stringify(out));
  const kinds = blocksOf((out as { doc: typeof c.doc }).doc).map((x) => `${x.kind}:${x.text}`);
  assert.deepEqual(kinds, ["h1:Plan", "p:We start with care.", "p:Then we grow."], "the heading is plain again; the person's words stay");
});

test("a step cannot be taken out once what it touched has been rewritten, and the reason says so", () => {
  const a = start();
  const b = ok(replaceBlockText(a, idOf(a, "start small"), "We begin."));
  let log = record(undefined, a.doc, b.doc, "agent", "reworded", 1);
  const c = ok(replaceBlockText(b, idOf(b, "begin"), "Something else entirely now."));
  log = record(log, b.doc, c.doc, "person", "rewrote", 10_000);
  const out = undoOp(c.doc, log, 1);
  assert.ok("error" in out && /cannot be taken out|later/.test(out.error), JSON.stringify(out));
  assert.ok("error" in undoOp(c.doc, log, 99));
});

test("the log is bounded, and reading one back checks it", () => {
  const a = start();
  let log: DocLog | undefined;
  let prev = a;
  for (let i = 0; i < MAX_OPS + 5; i++) {
    const next = ok(replaceBlockText(prev, idOf(prev, i === 0 ? "start small" : `w${i - 1}`), `w${i}`));
    log = record(log, prev.doc, next.doc, "agent", `edit ${i}`, i * 10_000);
    prev = next;
  }
  assert.equal(log!.ops.length, MAX_OPS);
  assert.equal(log!.next, MAX_OPS + 6);
  assert.equal(readLog(JSON.parse(JSON.stringify(log)))!.ops.length, MAX_OPS);
  assert.equal(readLog({ next: 1, ops: [{ n: "x" }] })!.ops.length, 0);
  assert.equal(readLog("nope"), undefined);
  void TextSelection;
  assert.ok(plainText(prev.doc).includes(`w${MAX_OPS + 4}`));
});

console.log("doc log tests passed");
