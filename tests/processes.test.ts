/**
 * Processes: the container's budget, and killing a tree without leaving
 * zombies behind.
 *
 * The bug this is here for (2026-10-18): PID 1 in the container was the node
 * server, and node does not wait() on children it did not spawn, so every
 * process reparented to it stayed a zombie. 8972 of them against a limit of
 * 9124, and every fork-based tool failed with "Resource temporarily
 * unavailable". Two things are proved here: a killed tree leaves nothing
 * behind (killTree takes it down deepest-first, so each parent is still alive
 * to collect its children), and the shipping compose file puts a real init in
 * front of node, which is the only thing that can collect an orphan at all.
 *
 *   npx tsx tests/processes.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const { cgroupPids, descendants, killTree, pressureText, processPressure, zombieCount, browserRoots, pidsInUse } = await import(
  "../server/processes"
);

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

/** Alive as far as the kernel is concerned -- a zombie counts as alive here,
    which is the point: it must not be there either. */
function exists(pid: number) {
  try {
    fs.readFileSync(`/proc/${pid}/stat`);
    return true;
  } catch {
    return false;
  }
}

const anyPid = (pids: number[]) => pids.find((p) => exists(p)) ?? null;

await test("pressureText says nothing while there is room", () => {
  assert.equal(pressureText({ current: 100, max: 9124, zombies: 12 }), null);
  assert.equal(pressureText({ current: 8000, max: 9124, zombies: 0 }), null);
  // No limit at all is not a budget to warn about.
  assert.equal(pressureText({ current: 9999, max: 0, zombies: 5 }), null);
});

await test("pressureText names the numbers, and the zombies, when it is nearly gone", () => {
  const note = pressureText({ current: 9098, max: 9124, zombies: 8972 });
  assert.ok(note, "a container at 99.7% of its pids must say so");
  assert.match(note!, /9,098\/9,124/);
  assert.match(note!, /8,972 of them zombie/);
  assert.match(note!, /restart/i);
  // "0 zombie" is worse than nothing: the count is left out, and so is the
  // advice, which would be wrong -- nothing to reap, nothing to restart for.
  const clean = pressureText({ current: 9100, max: 9124, zombies: 0 })!;
  assert.doesNotMatch(clean, /zombie/);
  assert.match(clean, /9,100/);
});

await test("the container's own numbers are readable", () => {
  const pids = cgroupPids();
  if (!pids) {
    console.log("       (no cgroup pids files here; nothing to read)");
    return;
  }
  assert.ok(pids.current > 0);
  assert.match(pidsInUse(), /^\d+/);
  assert.ok(zombieCount() >= 0);
});

await test("processPressure only speaks under pressure", () => {
  const note = processPressure();
  if (note) assert.match(note, /out of processes/);
  else assert.ok(true);
});

await test("killTree takes a whole tree down, and leaves no zombie behind", async () => {
  const before = zombieCount();
  // A leader with two children of its own, waiting: the shape of a terminal
  // command that forked, or of a browser and its renderers.
  const leader = spawn(
    "/bin/sh",
    ["-c", 'sh -c "sleep 300" & sh -c "sleep 300" & wait'],
    { detached: true, stdio: "ignore" },
  );
  assert.ok(leader.pid, "the fake tree did not start");
  const tree = await (async () => {
    const deadline = Date.now() + 5000;
    let found: number[] = [];
    while (Date.now() < deadline) {
      found = descendants(leader.pid!);
      if (found.length >= 2) return found;
      await new Promise((r) => setTimeout(r, 25));
    }
    return found;
  })();
  assert.ok(tree.length >= 2, `expected at least two children, saw ${tree.length}`);

  const killed = killTree(leader.pid!);
  assert.ok(killed >= 3, `killTree killed ${killed}, expected the leader and both children`);

  // Give the kernel a moment to finish the exits and the parents to collect.
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (!anyPid([leader.pid!, ...tree])) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  const survivor = anyPid([leader.pid!, ...tree]);
  assert.equal(survivor, null, `pid ${survivor} of the tree is still there`);

  /* Nothing of that tree may be left as a zombie. A zombie is not killable,
     so this can only hold if each parent was still alive to collect its
     children when they died -- which is why killTree kills deepest first and
     the parent last. */
  assert.ok(zombieCount() <= before, `zombies went from ${before} to ${zombieCount()}`);
});

await test("killTree refuses to kill itself or PID 1", () => {
  assert.equal(killTree(process.pid), 0);
  assert.equal(killTree(1), 0);
  assert.equal(killTree(0), 0);
});

await test("browserRoots lists the server's own browsers, not the shell's", () => {
  // Nothing may be claimed that is not a direct chromium child of this process.
  for (const pid of browserRoots()) {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/)[1]);
    assert.equal(ppid, process.pid);
    assert.match(fs.readFileSync(`/proc/${pid}/cmdline`, "utf8"), /--remote-debugging-pipe/);
  }
});

await test("the shipping compose file puts a real init in front of node", () => {
  /* The only thing that collects an orphan is a wait() on it, and the process
     that can is PID 1. Node cannot; docker-init can, and `init: true` is what
     makes it PID 1. Without this line everything else in this file is a
     tidy-up of a leak that still fills the container. */
  const file = path.join(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), "..", "blofstedt-autora", "docker-compose.yml");
  const text = fs.readFileSync(file, "utf8");
  /* Keep the "  app:" line itself. Starting the slice at the newline before it
     makes the split below match at position 0, which cut the service down to
     the empty string and failed whatever the file said. */
  const at = text.indexOf("\n  app:");
  assert.ok(at >= 0, "the compose file has no app service");
  const app = text.slice(at + 1);
  const service = app.split(/\n {2}\w+:/)[0] ?? app;
  assert.ok(service.length > 0, "the app service is empty");
  assert.match(service, /^\s+init:\s*true\s*$/m, "the app service must carry init: true");
});

console.log(`\nprocesses: ${passed} passed`);
