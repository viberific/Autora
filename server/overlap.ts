/**
 * Overlap analysis: whether calls made at the same time can step on one another.
 *
 * The agent may ask for several things in one response, and the lead may start
 * several agents at once. Running them together is faster, but only when none
 * of them can break another. Each call is given a footprint -- what it reads and
 * what it changes -- and two calls may share a moment only when neither changes
 * something the other touches. Anything not understood is treated as changing
 * everything, so it runs alone: a call whose footprint is unknown is never
 * guessed to be safe.
 *
 * Pure and instant (no model, no I/O), so it runs in the background of the
 * turn at no cost. `plan` keeps the order the calls were made in: a call never
 * overtakes an earlier one it conflicts with.
 */

import { looksOnly } from "./modes";

interface Footprint {
  /** What it only looks at. `world` is everything. */
  reads: string[];
  /** What it changes. */
  writes: string[];
}

/** A call that may change anything, or that shares something there is one of (a shell, a page): it runs alone. */
const ALONE: Footprint = { reads: [], writes: ["world"] };

/** Tool families that drive one window each: opening or driving one changes it, looking at it does not. */
const WINDOWS = ["office_", "video_", "photo_", "studio_", "panacea_", "pdf_", "app_", "cad_", "game_"];

const FILE_WORD = /(?:~|\.{0,2}\/)?(?:[\w.@-]+\/)+[\w.@-]*[\w@-]|\b[\w-]+\.[a-z][a-z0-9]{0,4}\b/gi;
const NOT_FILES = /^(?:e\.g|i\.e|etc|vs|approx)\.?$|\.(?:com|org|net|io|dev|app|ai|co|uk|de)$|^https?:/i;

const norm = (p: string) => p.trim().replace(/^\.\//, "").replace(/\/+$/, "").toLowerCase();

/** The files and folders a piece of free text names. */
export function pathsIn(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, " ").match(FILE_WORD) ?? []) {
    if (NOT_FILES.test(m)) continue;
    const p = norm(m);
    if (p) found.add(p);
  }
  return [...found];
}

/** Whether two resources are the same thing, or one holds the other (a folder and a file in it). */
function same(a: string, b: string): boolean {
  if (a === "world" || b === "world") return true;
  if (a === b) return true;
  if (!a.startsWith("file:") || !b.startsWith("file:")) return false;
  const x = a.slice(5);
  const y = b.slice(5);
  return x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}

/** Why two footprints cannot share a moment, or null when they can. */
export function conflict(a: Footprint, b: Footprint): string | null {
  const hit = (xs: string[], ys: string[]) => xs.find((x) => ys.some((y) => same(x, y)));
  const ww = hit(a.writes, b.writes);
  if (ww) return `both change ${ww}`;
  const wr = hit(a.writes, b.reads);
  if (wr) return `one changes ${wr} that the other reads`;
  const rw = hit(a.reads, b.writes);
  if (rw) return `one changes ${rw} that the other reads`;
  return null;
}

/** What one tool call reads and changes. */
export function footprint(name: string, args: Record<string, any> = {}): Footprint {
  if (name === "research") return { reads: ["world"], writes: [] };
  if (name === "agents") {
    const action = String(args.action ?? "").trim().toLowerCase();
    if (action === "list") return { reads: ["world"], writes: [] };
    if (action === "run") {
      const jobs = Array.isArray(args.tasks) && args.tasks.length ? args.tasks : [args];
      return agentFootprint(jobs.map((j: any) => ({ agent: String(j?.agent ?? ""), task: String(j?.task ?? "") })));
    }
    return ALONE;
  }
  // One shell, one page: their state is shared by everything done in them, whatever the command.
  if (name === "terminal" || name.startsWith("browser_")) return ALONE;
  // The person's edits are told from the agent's by what changed between two calls, so a change is never made beside another.
  if (name === "edit_file") return ALONE;
  const window = WINDOWS.find((w) => name.startsWith(w));
  if (window && looksOnly(name, args)) {
    // Opening or starting one is a change of what the window shows; reading it is not.
    const opens = /_(?:open|ui|preview)$/.test(name);
    return opens ? { reads: [], writes: [`window:${window}`] } : { reads: [`window:${window}`], writes: [] };
  }
  if (window) return { reads: [], writes: [`window:${window}`] };
  if (looksOnly(name, args)) return { reads: ["world"], writes: [] };
  return ALONE;
}

/** What a set of tasks handed to agents will change: the agents themselves, and the files the tasks name. */
function agentFootprint(jobs: Array<{ agent: string; task: string }>): Footprint {
  const writes = new Set<string>();
  for (const j of jobs) {
    if (j.agent) writes.add(`agent:${j.agent.trim().toLowerCase()}`);
    for (const p of pathsIn(j.task)) writes.add(`file:${p}`);
  }
  return { reads: [], writes: [...writes] };
}

/**
 * The batches to run, in order: the calls inside a batch run together, and a
 * batch starts when the one before it has finished. A call joins the open batch
 * only if it conflicts with nothing in it, so order between calls that touch
 * the same thing is the order they were made in.
 */
export function plan(prints: Footprint[]): number[][] {
  const batches: number[][] = [];
  for (let i = 0; i < prints.length; i++) {
    const open = batches[batches.length - 1];
    if (open && open.every((j) => conflict(prints[j], prints[i]) === null)) open.push(i);
    else batches.push([i]);
  }
  return batches;
}

/** The batches for several tool calls made in one response. */
export function planCalls(calls: Array<{ name: string; args?: Record<string, any> }>): number[][] {
  return plan(calls.map((c) => footprint(c.name, c.args ?? {})));
}

/**
 * Tasks handed to agents at the same time: the groups that may run together
 * and, for a task held back, what it waits for. Two tasks that name the same
 * file, or the same agent, do not overlap.
 */
export function planTasks(jobs: Array<{ agent: string; task: string }>): { batches: number[][]; held: Map<number, string> } {
  const prints = jobs.map((j) => agentFootprint([j]));
  const batches = plan(prints);
  const held = new Map<number, string>();
  batches.forEach((batch, n) => {
    if (n === 0) return;
    for (const i of batch) {
      for (const earlier of batches.slice(0, n).flat()) {
        const why = conflict(prints[earlier], prints[i]);
        if (why) { held.set(i, `${why} (after ${jobs[earlier].agent})`); break; }
      }
    }
  });
  return { batches, held };
}
