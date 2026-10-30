/**
 * Background jobs: commands that outlive the turn that started them.
 *
 * The point of them is that the exit code arrives after whoever started them
 * has gone, so it is written by the shell to a file rather than collected in
 * this process. What is asserted here is that the real thing runs: a command
 * is started detached, its output is on disk, its exit code is read back from
 * the file, a job still going is reported as running, stopping one ends it,
 * and a job with nowhere to run fails loudly instead of pretending.
 *
 *   npx tsx tests/background.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AUTORA_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "autora-bg-"));
const bg = await import("../server/background");

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}`);
    throw err;
  }
}

async function eventually(check: () => boolean, ms = 10_000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return check();
}

const cwd = os.tmpdir();
const work = (id: string) => bg.findJob(id);

await test("a command runs, prints, and its exit code is read back", async () => {
  const started = bg.startJob({
    command: "printf 'first\\nsecond\\n'; exit 7",
    cwd,
    note: "a job that fails on purpose",
    session: "session-test",
  });
  assert.ok(started.job, started.error);
  const id = started.job!.id;
  assert.ok(await eventually(() => work(id)?.state === "finished"), "it never finished");
  const job = work(id)!;
  assert.equal(job.exit, 7);
  assert.match(bg.readTail(job), /first\nsecond/);
  assert.equal(job.note, "a job that fails on purpose");
});

await test("a job still going is running, and its output can be read early", async () => {
  const started = bg.startJob({
    command: "echo working; sleep 30",
    cwd,
    session: "session-test",
  });
  assert.ok(started.job, started.error);
  const id = started.job!.id;
  assert.ok(await eventually(() => (work(id)?.last ?? "").includes("working")), "it printed nothing");
  assert.equal(work(id)?.state, "running");
  assert.equal(work(id)?.exit, null);
  assert.match(bg.backgroundBriefing(), new RegExp(id));
});

await test("stopping a running job ends it, with the code a killed process has", async () => {
  const list = bg.listJobs();
  const running = list.find((j) => j.state === "running");
  assert.ok(running, "no running job to stop");
  const stopped = bg.stopJob(running!.id);
  assert.equal(stopped.ok, true, stopped.message);
  assert.ok(await eventually(() => work(running!.id)?.state !== "running"), "it is still running");
  assert.equal(work(running!.id)?.exit, 143);
  assert.equal(bg.stopJob(running!.id).ok, false);
  assert.equal(bg.stopJob("job-nothing").ok, false);
});

await test("a directory that does not exist is refused, not half-started", () => {
  const started = bg.startJob({ command: "echo hi", cwd: "/no/such/directory/here", session: "s" });
  assert.equal(started.job, undefined);
  assert.match(started.error ?? "", /no directory/);
  assert.equal(bg.startJob({ command: "   ", cwd, session: "s" }).job, undefined);
});

await test("an unknown id is reported as unknown", () => {
  assert.equal(bg.findJob("job-made-up"), null);
  assert.equal(bg.findJob(""), null);
});

await test("a job is described in one sentence, and finished ones age out of the note", () => {
  const base = {
    id: "job-x1", command: "npm run build", cwd: "/tmp", pid: 1, started: Date.now(),
    note: "rebuilding", session: "s", log: "/tmp/x.log", exitFile: "/tmp/x.exit",
  };
  const running = bg.describe({ ...base, state: "running", exit: null, finished: null, seconds: 12, last: "" });
  assert.match(running, /still running/);
  const done = bg.describe({ ...base, state: "finished", exit: 1, finished: Date.now(), seconds: 300, last: "" });
  assert.match(done, /finished after 5m, exit 1/);
  const gone = bg.describe({ ...base, state: "gone", exit: null, finished: null, seconds: 90, last: "" });
  assert.match(gone, /no longer running/);
  // A finish from days ago is history: the log is still there, the note is not.
  const old = { ...base, started: Date.now() - 3 * 24 * 3600 * 1000 };
  const files = fs.readdirSync(path.join(process.env.AUTORA_STATE_DIR!, "background"));
  assert.ok(files.some((f) => f.endsWith(".log")), "no logs were written");
  assert.equal(bg.backgroundBriefing(old.started + 3 * 24 * 3600 * 1000).includes("job-x1"), false);
});

await test("background_output waits for a job to end in one call, and stops waiting when the turn is stopped", async () => {
  const { findTool, runTool } = await import("../server/tools");
  const spec = findTool("background_output")!;
  const ctx = (stopped = false) => ({ session: "session-test", cancelled: () => stopped, memory: { incognito: false } }) as any;
  const slow = bg.startJob({ command: "sleep 1.2; echo done-at-last", cwd, session: "session-test" }).job!;
  const asked = Date.now();
  const out = await runTool(spec, { id: slow.id, wait: 20 }, ctx());
  assert.ok(Date.now() - asked < 8000, "answered when the job ended, not when the wait ran out");
  assert.ok(out.ok, out.summary);
  assert.match(out.summary, /ended while waiting/);
  assert.match(out.summary, /done-at-last/);
  const still = bg.startJob({ command: "sleep 30", cwd, session: "session-test" }).job!;
  const quick = await runTool(spec, { id: still.id }, ctx());
  assert.match(quick.summary, /still running: .*pass wait/, "without wait it says it can wait");
  const at = Date.now();
  const cut = await runTool(spec, { id: still.id, wait: 60 }, ctx(true));
  assert.ok(Date.now() - at < 2000, "a stopped turn does not wait");
  assert.match(cut.summary, /still running/);
  bg.stopJob(still.id);
});

console.log(`\n${passed} passed`);
