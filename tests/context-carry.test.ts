/**
 * Keeping what the vendor has cached: the turn note stays on the message it was first sent with, a turn soon after
 * carries the last one's tool work on while the cache holds it, and the anchored record rides in the history rather
 * than the system text (server/context.ts).
 *
 *   npx tsx tests/context-carry.test.ts
 */
import assert from "node:assert/strict";
import { ContextEngine } from "../server/context";
import type { ChatMessage } from "../server/llm";

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

const MODEL = "anthropic/claude-sonnet-5-5";
const MIN = 5 * 60_000;

/** A turn: the person asks, the agent reads a file, then answers. */
function aTurn(): ContextEngine {
  const engine = new ContextEngine();
  engine.load([{ message: { role: "user", text: "fix the bug" }, seq: 1 }]);
  engine.setTurnNote("[note one]");
  engine.messagesFor("s"); // the turn's first request
  engine.append({ role: "assistant", text: "", calls: [{ id: "c1", name: "read_file", args: { path: "a.ts" } }] }, 2);
  engine.append({ role: "tool", replies: [{ id: "c1", name: "read_file", ok: true, result: "export const a = 1;" }] }, 3);
  return engine;
}

console.log("context: keeping the cache");

test("a user message the loop adds mid-turn does not move the note off the person's message", () => {
  const engine = aTurn();
  const before = engine.messagesFor("s");
  engine.append({ role: "user", text: "(Autora: the check failed.)" }, 4);
  const after = engine.messagesFor("s");
  assert.deepEqual(after.slice(0, before.length), before, "everything already sent is sent again byte for byte");
  assert.match(after[0].text!, /\[note one\]/);
  assert.doesNotMatch(after[after.length - 1].text!, /\[note one\]/);
});

test("the next turn soon after, on the same model, carries the reading on, with the old note written in", () => {
  const engine = aTurn();
  const sentLast = engine.messagesFor("s");
  engine.endTurn(MODEL);
  const through = engine.canCarry(MODEL, MIN);
  assert.equal(through, 3);
  engine.continueWith([
    { message: { role: "assistant", text: "Fixed." }, seq: 5 },
    { message: { role: "user", text: "now add a test" }, seq: 6 },
  ]);
  engine.setTurnNote("[note two]");
  const now = engine.messagesFor("s");
  assert.deepEqual(now.slice(0, sentLast.length), sentLast, "the last turn's requests are a prefix of this one: a cache read");
  assert.equal(now[2].replies?.[0].result, "export const a = 1;", "the file it read is still there");
  assert.match(now[now.length - 1].text!, /now add a test\n\n\[note two\]/);
});

test("no carrying on to another model, after the cache has gone, or past a stop mid-call", () => {
  const other = aTurn();
  other.endTurn(MODEL);
  assert.equal(other.canCarry("openai/gpt-6-luna", MIN), null);
  assert.equal(other.canCarry(MODEL, -1), null, "too late");
  const stopped = aTurn();
  stopped.append({ role: "assistant", text: "", calls: [{ id: "c2", name: "terminal", args: {} }] }, 4);
  stopped.endTurn(MODEL);
  assert.equal(stopped.canCarry(MODEL, MIN), null);
});

test("loading the history from words forgets what could have been carried", () => {
  const engine = aTurn();
  engine.endTurn(MODEL);
  engine.load([{ message: { role: "user", text: "fresh" }, seq: 9 }]);
  assert.equal(engine.canCarry(MODEL, MIN), null);
});

test("the anchored record goes at the head of the history when asked, and in the system text otherwise", () => {
  const engine = aTurn();
  (engine as unknown as { anchored: string }).anchored = "- the goal";
  assert.match(engine.systemFor("pinned"), /ANCHORED WORKING MEMORY/, "sizes are still reckoned with it");
  const sent: ChatMessage[] = engine.messagesFor(engine.systemFor("pinned"), { anchorInMessages: true });
  assert.match(sent[0].text!, /^=== ANCHORED WORKING MEMORY ===[\s\S]*- the goal[\s\S]*fix the bug/);
  assert.equal(sent[0].role, "user");
});

console.log(`${passed} passed`);
