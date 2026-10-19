/**
 * The container's process budget, and how to take a whole tree down.
 *
 * On 2026-10-18 this container reached 9098 of its 9124 processes, 8972 of
 * them zombies, and every fork-based tool began failing with
 * `timeout: fork: Resource temporarily unavailable` -- which the tools
 * reported as "the phone is offline" and cost hours to run down.
 *
 * What makes a zombie here, and why there are so many: PID 1 in this
 * container was `node dist/server.cjs` itself, with no init in front of it
 * (there is now: `init: true` in blofstedt-autora/docker-compose.yml). A
 * process is orphaned whenever its parent dies first -- every member of a
 * killed terminal command's process group, every chromium renderer whose
 * browser exits first -- and an orphan is reparented to PID 1. Node waits on
 * the children it spawned itself and on nothing else, so an orphan's exit is
 * never collected and it stays a zombie for the life of the container. They
 * cannot be killed afterwards: only a parent's wait() removes one.
 *
 * So the durable answer is the init (which reaps them), and the two things
 * this module adds on top are: never leave a tree to be orphaned in the first
 * place (killTree), and say plainly when the budget is nearly gone instead of
 * passing on a bare EAGAIN (processPressure).
 */
import fs from "node:fs";

/** How many processes the container may have, and how many it has. cgroup v2
    keeps these as two small files; null where there is no cgroup (a dev box). */
export function cgroupPids(): { current: number; max: number } | null {
  const read = (name: string) => {
    for (const root of ["/sys/fs/cgroup", "/host/sys/fs/cgroup"]) {
      try {
        const text = fs.readFileSync(`${root}/${name}`, "utf8").trim();
        const n = Number(text);
        if (Number.isFinite(n) && n > 0) return n;
      } catch {
        // Try the next place, then give up.
      }
    }
    return null;
  };
  const current = read("pids.current");
  if (current === null) return null;
  // "max" means no limit at all, which is not a budget to warn about.
  const max = read("pids.max");
  return { current, max: max ?? 0 };
}

/** Processes of ours that have exited and whose parent never collected them.
    Reads /proc, so it is the real count and not a statistic. */
export function zombieCount(): number {
  let n = 0;
  let names: string[];
  try {
    names = fs.readdirSync("/proc");
  } catch {
    return 0;
  }
  for (const name of names) {
    if (name.charCodeAt(0) < 48 || name.charCodeAt(0) > 57) continue;
    try {
      const stat = fs.readFileSync(`/proc/${name}/stat`, "utf8");
      // "pid (comm) S ..." -- comm may hold spaces and parentheses, so the
      // state is the first field after the last ")".
      const state = stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
      if (state === "Z") n += 1;
    } catch {
      // Gone while we looked.
    }
  }
  return n;
}

/** What the numbers say, in the words the person and the model should read --
    or null when there is room enough to work in. `zombies` of 0 is left out
    rather than printed as "0 zombie". */
export function pressureText(p: { current: number; max: number; zombies: number }, share = 0.9): string | null {
  if (!p.max || p.current < p.max * share) return null;
  const dead = p.zombies > 0 ? `, ${p.zombies.toLocaleString("en-US")} of them zombie` : "";
  const why = p.zombies > 0
    ? " Nothing that needs to fork will work, and a zombie cannot be cleared without restarting Autora: only a parent's wait can collect one."
    : " Nothing that needs to fork will work until some of them let go.";
  return `The container is out of processes (${p.current.toLocaleString("en-US")}/${p.max.toLocaleString("en-US")}${dead}).${why}`;
}

/** The same, measured now. Reading the cgroup is two small files; counting
    zombies is a walk of /proc, so it only happens when the budget is close. */
export function processPressure(): string | null {
  const pids = cgroupPids();
  if (!pids?.max) return null;
  if (pids.current < pids.max * 0.9) return null;
  return pressureText({ ...pids, zombies: zombieCount() });
}

/** Every descending process of `pid`, deepest first, read from /proc before
    anything is killed -- once the top is gone its children are reparented and
    the tree is lost. */
export function descendants(pid: number): number[] {
  const childrenOf = new Map<number, number[]>();
  let names: string[];
  try {
    names = fs.readdirSync("/proc");
  } catch {
    return [];
  }
  for (const name of names) {
    if (name.charCodeAt(0) < 48 || name.charCodeAt(0) > 57) continue;
    try {
      const stat = fs.readFileSync(`/proc/${name}/stat`, "utf8");
      const parent = Number(stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/)[1]);
      const child = Number(name);
      const list = childrenOf.get(parent);
      if (list) list.push(child);
      else childrenOf.set(parent, [child]);
    } catch {
      // Gone while we looked.
    }
  }
  const out: number[] = [];
  const walk = (id: number) => {
    for (const child of childrenOf.get(id) ?? []) {
      walk(child);
      out.push(child);
    }
  };
  walk(pid);
  return out;
}

/** Sleep without holding the event loop's timers up; killTree is called from
    paths (a cancelled tool call) that want it done before they return. */
function blockFor(ms: number) {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}

/** Kill a process and everything under it. Playwright and the terminal tool
    both spawn with `detached: true`, so the leader also leads a process group
    and the group kill takes any member that has moved to its own parent.

    The group is FROZEN before anything dies, and that is the point of it.
    Children used to be killed first, deepest first, with the leader left running
    `graceMs` to collect them -- and the leader is a shell: the moment its child
    dies, bash runs the NEXT command in the chain. So `sleep 3; echo done > f`
    timed out, the `sleep` was killed, and the shell went on to write `f` after
    the agent had been told the call was over. Frozen first, nothing can take
    another step, and the tree is then killed in any order. A stopped leader
    cannot reap, so its children are reparented to PID 1 -- docker-init in the
    container, an init on a runner and on any normal host, all of which reap. A
    process that carries on after it was stopped is the worse of the two. */
export function killTree(pid: number, signal: NodeJS.Signals = "SIGKILL", graceMs = 150): number {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return 0;
  const tree = descendants(pid);
  const killOne = (id: number, sig: NodeJS.Signals) => {
    try {
      process.kill(id, sig);
      return true;
    } catch {
      return false;
    }
  };
  const alive = (id: number) => {
    try {
      process.kill(id, 0);
      return true;
    } catch {
      return false;
    }
  };
  /* Freeze the whole group before killing anything, so that no member can run
     a step while the rest is being taken down: a shell whose child is killed
     carries on with the next command in the chain otherwise. Both the group and
     each member are stopped, because a member that left the group would miss
     the group signal. */
  let froze = false;
  try {
    process.kill(-pid, "SIGSTOP");
    froze = true;
  } catch {
    // Not a group leader: the members are stopped one by one below.
  }
  if (!froze && killOne(pid, "SIGSTOP")) froze = true;
  for (const id of tree) if (killOne(id, "SIGSTOP")) froze = true;

  let killed = 0;
  for (const id of tree) if (killOne(id, signal)) killed += 1;
  if (killOne(pid, signal)) killed += 1;
  // The sweep, for a member the /proc scan missed. Usually nothing is left.
  try {
    process.kill(-pid, signal);
    killed += 1;
  } catch {
    // Not a group leader, or the group is already empty.
  }
  // A moment for them to be gone, so a caller that looks straight after sees none.
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && (alive(pid) || tree.some(alive))) blockFor(10);
  return killed;
}

/**
 * The chromium processes this server launched.
 *
 * Playwright starts the browser as a direct child with
 * `--remote-debugging-pipe` on its command line; its renderers, zygotes and
 * crash handlers are children of that one and carry neither the flag nor our
 * pid, which is why they are found through the tree rather than the flag.
 */
export function browserRoots(): number[] {
  const out: number[] = [];
  let names: string[];
  try {
    names = fs.readdirSync("/proc");
  } catch {
    return out;
  }
  for (const name of names) {
    if (name.charCodeAt(0) < 48 || name.charCodeAt(0) > 57) continue;
    try {
      const cmdline = fs.readFileSync(`/proc/${name}/cmdline`, "utf8");
      if (!cmdline.includes("--remote-debugging-pipe")) continue;
      const stat = fs.readFileSync(`/proc/${name}/stat`, "utf8");
      const parent = Number(stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/)[1]);
      if (parent === process.pid) out.push(Number(name));
    } catch {
      // Gone while we looked.
    }
  }
  return out;
}

/** A browser is a tree of twenty-odd processes and closing it through the
    DevTools protocol leaves its children to exit on their own, in their own
    time, into PID 1's arms. Give them a moment to go quietly and then take
    down whatever is left of the tree. */
export async function settleTree(pid: number, waitMs = 1500): Promise<number> {
  const deadline = Date.now() + waitMs;
  const alive = () => fs.existsSync(`/proc/${pid}`);
  while (Date.now() < deadline && alive()) await new Promise((r) => setTimeout(r, 50));
  if (alive()) return killTree(pid);
  return 0;
}

/** A one-off sweep for a server that has just started: any chromium left by a
    previous run of this server in the same container is unreachable and only
    waits to be orphaned. Matches on the profile directory, so a browser
    belonging to anything else is left alone. */
export function sweepBrowsers(markers: string[]): number {
  if (!markers.length) return 0;
  const roots = browserRoots();
  let n = 0;
  let names: string[];
  try {
    names = fs.readdirSync("/proc");
  } catch {
    return 0;
  }
  for (const name of names) {
    if (name.charCodeAt(0) < 48 || name.charCodeAt(0) > 57) continue;
    let cmdline: string;
    try {
      cmdline = fs.readFileSync(`/proc/${name}/cmdline`, "utf8");
    } catch {
      continue;
    }
    if (!cmdline.includes("--remote-debugging-pipe")) continue;
    if (!markers.some((m) => m && cmdline.includes(m))) continue;
    const pid = Number(name);
    if (roots.includes(pid)) continue; // One of ours, running now.
    if (killTree(pid) > 0) n += 1;
  }
  return n;
}

/** Kept for the callers that want the count the kernel itself keeps. */
export function pidsInUse(): string {
  const pids = cgroupPids();
  if (!pids) return "no cgroup pids limit on this machine";
  return `${pids.current}${pids.max ? `/${pids.max}` : ""}`;
}
