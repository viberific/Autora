/**
 * What the model is told of the session, read out of the log (server/history.ts), and images lifted out of a
 * streaming reply (server/datasieve.ts).
 *
 *   npx tsx tests/history.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AUTORA_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "autora-history-"));
const { historyFor, pastToolCalls } = await import("../server/history");
const { DataUrlSieve } = await import("../server/datasieve");

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

let seq = 0;
const ev = (kind: string, payload: Record<string, unknown>, span?: string) => ({ seq: ++seq, kind, payload, ts: 0, actor: "agent", ...(span ? { span } : {}) });
const session = (events: ReturnType<typeof ev>[]) => ({ id: "s-history", events }) as any;

console.log("history");

test("stream deltas join into one reply; console text and a leading reply are left out", () => {
  seq = 0;
  const s = session([
    ev("turn.agent.text", { text: "Hello, " }),
    ev("turn.user", { text: "hi" }),
    ev("turn.agent.text", { text: "Hello, " }),
    ev("turn.agent.text", { text: "there." }),
    ev("turn.agent.text", { text: "No model is connected.", local: true }),
    ev("turn.user", { text: "again" }),
  ]);
  const h = historyFor(s).map((t) => t.message);
  assert.deepEqual(h, [{ role: "user", text: "hi" }, { role: "assistant", text: "Hello, there." }, { role: "user", text: "again" }]);
});

test("each message carries the last seq it was built from, and a fold's seq leaves the earlier ones out", () => {
  seq = 0;
  const s = session([ev("turn.user", { text: "a" }), ev("turn.agent.text", { text: "b" }), ev("turn.user", { text: "c" })]);
  assert.deepEqual(historyFor(s).map((t) => t.seq), [1, 2, 3]);
  assert.deepEqual(historyFor(s, 1).map((t) => t.message.text), ["b", "c"]);
});

test("past calls are paired with their results by span, failures with why", () => {
  seq = 0;
  const s = session([
    ev("tool.call", { name: "terminal", args: { command: "npm test" } }, "a"),
    ev("tool.result", { ok: false, preview: "1 failing", display: { exit_code: 1 } }, "a"),
    ev("tool.call", { name: "read_file", args: { path: "x.ts" } }, "b"),
    ev("tool.result", { ok: true, preview: "x.ts" }, "b"),
  ]);
  const lines = pastToolCalls(s);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /npm test[\s\S]*exit 1 -- 1 failing/);
  assert.match(lines[1], /x\.ts/);
  assert.deepEqual(pastToolCalls(s, 2), [lines[1]], "only calls after the seq");
  assert.deepEqual(pastToolCalls(undefined), []);
});

console.log("data-url sieve");

test("an image split across deltas is lifted out whole, and the words around it flow", () => {
  const sieve = new DataUrlSieve();
  const a = sieve.feed("Here it is: data:ima");
  const b = sieve.feed("ge/png;base64,AAAA rest.");
  const c = sieve.flush();
  assert.equal(a.text + b.text + c.text, "Here it is:  rest.");
  assert.deepEqual([...a.images, ...b.images, ...c.images], ["data:image/png;base64,AAAA"]);
});

test("text with no image passes through untouched", () => {
  const sieve = new DataUrlSieve();
  const out = sieve.feed("plain words");
  assert.equal(out.text + sieve.flush().text, "plain words");
});

console.log(`${passed} passed`);
