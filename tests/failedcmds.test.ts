/**
 * A command that failed is not run again unchanged while nothing has changed since (server/failedcmds.ts), and the
 * console's "carry on" nudges stay out of the conversation (quiet system.log, lib/activity.ts).
 *
 *   npx tsx tests/failedcmds.test.ts
 */
import assert from "node:assert/strict";
import { FORGET_AFTER_MS, failuresBriefing, repeatRefusal, standingFailure } from "../server/failedcmds";
import { readActivity } from "../src/lib/activity";
import { derive } from "../src/lib/derive";

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

const NOW_S = 1_800_000_000;
const NOW = NOW_S * 1000;
let seq = 0;
let spans = 0;
type Ev = { seq: number; ts: number; kind: string; actor: string; span?: string; payload: any };
/** A call and how it came back, as the loop logs them. */
function ran(name: string, args: Record<string, unknown>, result: { exit?: number; ok?: boolean; preview?: string; error?: string; repeat?: boolean }): Ev[] {
  const span = `s${++spans}`;
  const call: Ev = { seq: ++seq, ts: NOW_S - 30, kind: "tool.call", actor: "agent", span, payload: { name, args } };
  const back: Ev = result.error !== undefined || result.repeat
    ? { seq: ++seq, ts: NOW_S - 30, kind: "tool.error", actor: "agent", span, payload: { error: result.error ?? "", ...(result.repeat ? { repeat: true } : {}) } }
    : { seq: ++seq, ts: NOW_S - 30, kind: "tool.result", actor: "agent", span, payload: { ok: result.ok ?? result.exit === 0, preview: result.preview ?? "", display: result.exit !== undefined ? { exit_code: result.exit } : undefined } };
  return [call, back];
}
const fail = (command: string, preview = "Error: Cannot find module 'left-pad'") => ran("terminal", { command }, { exit: 1, preview });

console.log("failed commands");

test("a failed command stands against itself, word for word and in the same folder, and says why", () => {
  const log = fail("npm test");
  const f = standingFailure(log, "npm   test ", "", NOW)!;
  assert.equal(f.exit, 1);
  assert.match(repeatRefusal(f, NOW), /Not run again: `npm test` failed 30 s ago \(exit 1\): Error: Cannot find module 'left-pad'/);
  assert.match(repeatRefusal(f, NOW), /retry/);
  assert.equal(standingFailure(log, "npm test", "other/dir", NOW), null, "another folder is another command");
  assert.equal(standingFailure(log, "npm run test", "", NOW), null);
});

test("anything that could change the outcome frees it: an edit, a file card, another command that changes things", () => {
  const edited = [...fail("npm test"), ...ran("edit_file", { path: "a.js", edits: [] }, { ok: true })];
  assert.equal(standingFailure(edited, "npm test", "", NOW), null);
  const card = [...fail("npm test"), { seq: ++seq, ts: NOW_S - 20, kind: "file.edit", actor: "user", payload: { path: "a.js" } }];
  assert.equal(standingFailure(card, "npm test", "", NOW), null, "the person's edit counts too");
  const own = fail("make > build.log");
  const wroteItsLog = [...own, { seq: ++seq, ts: NOW_S - 20, kind: "file.edit", actor: "agent", span: own[0].span, payload: { path: "build.log" } }];
  assert.ok(standingFailure(wroteItsLog, "make > build.log", "", NOW), "a file the command wrote itself is no change");
  const installed = [...fail("npm test"), ...ran("terminal", { command: "npm install left-pad" }, { exit: 1, preview: "ERR" })];
  assert.equal(standingFailure(installed, "npm test", "", NOW), null, "even a failed install may have changed something");
});

test("only looking does not free it, and neither does being refused", () => {
  const looked = [...fail("npm test"), ...ran("terminal", { command: "ls node_modules" }, { exit: 0 }), ...ran("read_file", { path: "a.js" }, { ok: true })];
  assert.ok(standingFailure(looked, "npm test", "", NOW));
  const refused = [...fail("npm test"), ...ran("terminal", { command: "npm test" }, { repeat: true })];
  assert.equal(standingFailure(refused, "npm test", "", NOW)!.tries, 1, "a refused repeat did not run, so it is not a second failure");
});

test("a pass clears it; a failure that often passes gets one more try; an old one is forgotten", () => {
  assert.equal(standingFailure([...fail("make"), ...ran("terminal", { command: "make" }, { exit: 0 })], "make", "", NOW), null);
  const flaky = fail("curl https://example.com", "curl: (28) Connection timed out");
  assert.equal(standingFailure(flaky, "curl https://example.com", "", NOW), null, "one more try");
  const twice = [...flaky, ...fail("curl https://example.com", "curl: (28) Connection timed out")];
  assert.ok(standingFailure(twice, "curl https://example.com", "", NOW), "not a third");
  assert.equal(standingFailure(fail("npm test"), "npm test", "", NOW + FORGET_AFTER_MS + 60_000), null);
});

test("a new turn is told what still fails, and nothing when nothing does", () => {
  const brief = failuresBriefing([...fail("npm test"), ...fail("docker ps", "docker: command not found")], NOW)!;
  assert.match(brief, /`npm test` exit 1: Error: Cannot find module/);
  assert.match(brief, /`docker ps` exit 1: docker: command not found/);
  assert.equal(failuresBriefing(ran("terminal", { command: "ls" }, { exit: 0 }), NOW), null);
});

console.log("carrying on, in the background");

test("a quiet nudge is not a bubble in the thread; the line under it says what is happening", () => {
  const events: any[] = [
    { seq: 1, ts: NOW_S, kind: "turn.user", actor: "user", payload: { text: "make the list" } },
    { seq: 2, ts: NOW_S, kind: "system.log", actor: "system", payload: { message: "The to-do list still had open items as the turn ended; asked the agent to bring it up to date.", quiet: true, activity: "Finishing the to-do list" } },
  ];
  const shown = JSON.stringify(derive(events as any).buckets);
  assert.doesNotMatch(shown, /bring it up to date/);
  assert.equal(readActivity(events as any).text, "Finishing the to-do list");
  const loud = [...events.slice(0, 1), { ...events[1], payload: { message: "A desktop connected." } }];
  assert.match(JSON.stringify(derive(loud as any).buckets), /A desktop connected/, "other notes still show");
});

console.log(`${passed} passed`);
