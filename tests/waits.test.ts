/**
 * A command whose whole job is to wait is refused, and says what to use instead.
 *
 * Measured over 118 sessions: 5,148 terminal calls, and a good part of the waste was a bare `sleep 120` between two
 * reads. What must never be caught is a real command: a build, a test run, a pipeline with a short sleep in it, or a
 * backgrounded job.
 *
 *   npx tsx tests/waits.test.ts
 */
import assert from "node:assert/strict";
import { waitsInside, WAIT_LIMIT_S } from "../server/guard";

console.log("terminal waits");

/* Refused: the command does nothing but wait, for more than the limit. */
assert.equal(waitsInside("sleep 120"), 120);
assert.equal(waitsInside("  sleep 30  "), 30);
assert.equal(waitsInside("sleep 11"), 11);
assert.equal(waitsInside("sleep 1m"), 60);
assert.equal(waitsInside("sleep 20s"), 20);
assert.equal(waitsInside("sleep 1.5m"), 90);
assert.equal(waitsInside("sudo sleep 60"), 60);
assert.equal(waitsInside("sleep 30; sleep 30"), 60);
assert.equal(waitsInside("sleep 30 && sleep 40"), 70);
assert.equal(waitsInside("timeout 120 sleep 60"), 60);
assert.equal(waitsInside("sleep 60\nsleep 60"), 120);

/* Left alone: short, backgrounded, or part of a command that does real work. */
assert.equal(waitsInside("sleep 10"), null, "the limit itself is allowed");
assert.equal(waitsInside("sleep 5"), null);
assert.equal(waitsInside("sleep 0"), null);
assert.equal(waitsInside("sleep"), null);
assert.equal(waitsInside("sleep 600 &"), null, "a backgrounded job returns at once");
assert.equal(waitsInside("nohup sleep 600 &"), null);
assert.equal(waitsInside("sleep 60 && curl -s https://example.com"), null);
assert.equal(waitsInside("sleep 60; echo done"), null);
assert.equal(waitsInside("sleep 5 && make"), null);
assert.equal(waitsInside("timeout 300 npm test"), null, "a time limit is not a wait");
assert.equal(waitsInside("timeout 60 ./build.sh"), null);
assert.equal(waitsInside("wait"), null);
assert.equal(waitsInside(""), null);

/* Real commands, exactly as they are run here: none may be refused. */
for (const cmd of [
  "npm run typecheck",
  "cd /data/work/a2 && git status --short",
  "npm test -- pdf",
  "npx tsx tests/toolbudget.test.ts",
  "git fetch -q origin && git rebase origin/main",
  "for i in 1 2 3; do echo $i; done",
  "ls -la | head -20",
]) {
  assert.equal(waitsInside(cmd), null, `${cmd} must run`);
}

assert.equal(WAIT_LIMIT_S, 10);
console.log("  ok  a command that only waits is caught, and real commands are not");
