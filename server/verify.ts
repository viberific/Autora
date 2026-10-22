/**
 * Not taking the agent's word that the work is done.
 *
 * A turn ends when the model stops asking for tools, so "done" has been
 * whatever the model said. When the person has named a check for their
 * project -- the linter, the tests, a build -- this runs it once the agent
 * says it is finished and has changed something, and puts the raw result in
 * front of the agent. The check is theirs and is plain code: it passes or it
 * does not, whatever the model believes. A failure sends the agent back to fix
 * it, up to a few runs a turn; after that the turn ends and says the check is
 * still failing rather than claiming a pass.
 *
 * With no command set, the project's own check is looked for (detectCheck): the
 * scripts in its package.json, its tsconfig, pytest, cargo, go. Found that way it
 * runs fewer times, and the agent is told it was not the person's choice, so a
 * suite that was already failing is reported rather than chased. Settings can turn
 * the looking off.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface VerifyConfig {
  /** The command to run in the terminal's directory. Empty: detect one, or none. */
  command: string;
  /** Most runs of it in one turn. */
  tries: number;
  /** With no command: look for the project's own check and run that. */
  auto: boolean;
}

export const VERIFY_DEFAULTS: VerifyConfig = { command: "", tries: 3, auto: true };

/** The check a turn runs: the person's, or one found in the project. */
export interface ProjectCheck {
  command: string;
  tries: number;
  /** Found by detectCheck, not set by the person. */
  auto: boolean;
  /** Where it runs. */
  cwd: string;
}

/** A detected check runs at most this often a turn: once, and once more after a fix. */
const AUTO_TRIES = 2;

/** Scripts worth running as the check, best first: a whole check, then types, then tests, then lint, then a build. */
const SCRIPT_ORDER = ["check", "verify", "typecheck", "type-check", "test", "lint", "build"];
/** A script that never ends on its own (a watcher, a server) is no check. */
const LONG_RUNNING = /--watch\b|\bwatch\b|nodemon|\bserve\b|\bdev\b|\bstart\b|storybook|--ui\b/;
/** npm's placeholder test script. */
const NO_TEST = /no test specified/;

const onPath = new Map<string, boolean>();
function has(command: string, args: string[] = ["--version"]): boolean {
  const key = `${command} ${args.join(" ")}`;
  if (!onPath.has(key)) {
    const r = spawnSync(command, args, { stdio: "ignore", timeout: 4_000 });
    onPath.set(key, r.status === 0);
  }
  return onPath.get(key)!;
}

function readJson(file: string): any {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

const exists = (dir: string, name: string) => fs.existsSync(path.join(dir, name));

/**
 * The check a project already has, in this folder, or null. Only what can run as it
 * stands: npm scripts only once its dependencies are installed, pytest only where it
 * is importable, cargo and go only where they are on the PATH. Several are joined
 * with && so the first failure stops the rest.
 */
export function detectCheck(dir: string): string | null {
  const pkg = readJson(path.join(dir, "package.json"));
  if (pkg && exists(dir, "node_modules")) {
    const scripts: Record<string, string> = pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
    const usable = (name: string) => typeof scripts[name] === "string" && !LONG_RUNNING.test(scripts[name]) && !NO_TEST.test(scripts[name]);
    const runner = exists(dir, "pnpm-lock.yaml") && has("pnpm") ? "pnpm" : exists(dir, "yarn.lock") && has("yarn") ? "yarn" : "npm";
    const run = (name: string) => (runner === "npm" ? `npm run -s ${name}` : `${runner} -s ${name}`);
    const whole = SCRIPT_ORDER.slice(0, 2).find(usable);
    if (whole) return `CI=1 ${run(whole)}`;
    // Types and tests together when both exist: each catches what the other does not.
    const picked = SCRIPT_ORDER.slice(2, 5).filter(usable).filter((n, i, all) => !(n === "type-check" && all.includes("typecheck")));
    if (picked.length) return `CI=1 ${picked.map(run).join(" && ")}`;
    if (exists(dir, "tsconfig.json") && exists(dir, "node_modules/.bin/tsc")) return "npx --no-install tsc --noEmit -p .";
    const rest = SCRIPT_ORDER.slice(5).find(usable);
    if (rest) return `CI=1 ${run(rest)}`;
  }
  if (!pkg && exists(dir, "tsconfig.json") && exists(dir, "node_modules/.bin/tsc")) return "npx --no-install tsc --noEmit -p .";
  if (exists(dir, "Cargo.toml") && has("cargo")) return "cargo check -q --message-format short";
  if (exists(dir, "go.mod") && has("go", ["version"])) return "go vet ./...";
  const python = ["pyproject.toml", "setup.py", "setup.cfg", "pytest.ini", "tox.ini"].some((f) => exists(dir, f)) ||
    exists(dir, "tests") && fs.readdirSync(path.join(dir, "tests")).some((f) => /^test_.*\.py$|_test\.py$/.test(f));
  if (python && has("python3", ["-c", "import pytest"])) return "python3 -m pytest -q -x";
  return null;
}

/**
 * The check this turn runs, or null for none. The person's command wins; otherwise,
 * when looking is on, the project's own, searched for from each folder the agent
 * changed files in up to the working folder (a project in a subfolder is found too),
 * then in the working folder itself.
 */
export function projectCheck(config: VerifyConfig, root: string, changed: readonly string[] = []): ProjectCheck | null {
  if (config.command) return { command: config.command, tries: config.tries, auto: false, cwd: root };
  if (!config.auto) return null;
  const top = path.resolve(root);
  const tried = new Set<string>();
  for (const file of [...changed].reverse()) {
    let dir = path.dirname(path.resolve(top, file));
    if (dir !== top && !dir.startsWith(top + path.sep)) continue;
    while (!tried.has(dir)) {
      tried.add(dir);
      const found = detectCheck(dir);
      if (found) return { command: found, tries: Math.min(config.tries, AUTO_TRIES), auto: true, cwd: dir };
      if (dir === top) break;
      dir = path.dirname(dir);
    }
  }
  if (tried.has(top)) return null;
  const found = detectCheck(top);
  return found ? { command: found, tries: Math.min(config.tries, AUTO_TRIES), auto: true, cwd: top } : null;
}

const MAX_COMMAND = 500;

/** A setting from the page or the file, made safe. */
export function mergeVerify(into: VerifyConfig, patch: any): VerifyConfig {
  if (patch && typeof patch === "object") {
    if (typeof patch.command === "string") {
      // One line: a newline would be a second command nobody read.
      into.command = patch.command.replace(/[\r\n]+/g, " ").trim().slice(0, MAX_COMMAND);
    }
    const n = Number(patch.tries);
    if (Number.isFinite(n)) into.tries = Math.min(10, Math.max(1, Math.round(n)));
    if (typeof patch.auto === "boolean") into.auto = patch.auto;
  }
  return into;
}

export interface CheckResult {
  command: string;
  /** Found in the project rather than set by the person (see projectCheck). */
  auto?: boolean;
  exitCode: number | null;
  ok: boolean;
  /** What it printed, already cut to a size the agent can read. */
  output: string;
}

const FAILURE_LINE = /\b(error|fail(?:ed|ure|ing)?|exception|assert\w*|expected|panic|cannot|unable|not found|undefined|TS\d{4})\b|✗|✘|×/i;
/** Output past this is cut down to what reports a failure. */
const FOCUS_OVER_CHARS = 4_000;
const FOCUS_MAX_LINES = 60;

/**
 * The part of a failing check's output worth reading: the lines that report a
 * failure with one line of context either side, in order. A passing test's
 * name or a progress bar carries nothing, and a long run of them buries the
 * one line that matters. Short output is returned as it is, and so is long
 * output that names no failure (cutting it would leave nothing).
 */
export function focusOutput(output: string): string {
  if (output.length <= FOCUS_OVER_CHARS) return output;
  const lines = output.split("\n");
  const keep = new Set<number>();
  let hits = 0;
  for (let i = 0; i < lines.length && hits < FOCUS_MAX_LINES; i += 1) {
    if (!FAILURE_LINE.test(lines[i])) continue;
    hits += 1;
    for (const j of [i - 1, i, i + 1]) if (j >= 0 && j < lines.length) keep.add(j);
  }
  if (keep.size === 0) return output;
  const out: string[] = [];
  let last = -2;
  for (const i of [...keep].sort((a, b) => a - b)) {
    if (i > last + 1) out.push("...");
    out.push(lines[i]);
    last = i;
  }
  if (last < lines.length - 1) out.push("...");
  return `(${lines.length} lines of output; the ones reporting a failure:)\n${out.join("\n")}`;
}

/** The failure lines of an output, as a set, so one run can be compared with the next. */
function failureKey(output: string): string {
  return output.split("\n").filter((l) => FAILURE_LINE.test(l))
    .map((l) => l.replace(/\d+/g, "#").replace(/\s+/g, " ").trim()).sort().join("\n");
}

/** What the agent is told when the check failed. `previous` is the failing
    output of the run before, when there was one: a run that fails exactly as
    the last did is told so in a line, not shown the same wall of text again. */
export function failedNote(r: CheckResult, run: number, tries: number, previous?: string): string {
  const left = tries - run;
  const unchanged = previous !== undefined && previous.trim() !== "" &&
    failureKey(previous) !== "" && failureKey(previous) === failureKey(r.output);
  const shown = unchanged
    ? "It fails exactly as it did on the last run: nothing you changed since has affected these failures. " +
      "Look at what you changed against what it reports, rather than repeating the fix."
    : focusOutput(r.output).trim() || "(no output)";
  return [
    `(Autora ran the project's check after your changes: \`${r.command}\` ` +
      `${r.exitCode === null ? "did not finish" : `exited ${r.exitCode}`}, so it did not pass. Its output:`,
    shown,
    left > 0
      ? `Fix what it reports and carry on; the check will run again when you are done (${left} more run${left === 1 ? "" : "s"} this turn). ` +
        "Do not say the work is finished while it is failing. If it fails for a reason that is not yours -- something already broken, " +
        "or an environment problem -- say so plainly rather than working around it." +
        (r.auto ? " This check was found in the project, not chosen by the person: failures in code you did not touch are theirs to know about, not yours to fix." : "") + ")"
      : "That was the last run this turn. Say plainly that it is still failing and what you could not fix; do not say the work is done.)",
  ].join("\n");
}

/** What the agent is told when the check was run because it just finished an item. */
export function itemCheckNote(r: CheckResult, previous?: string): string {
  if (r.ok) return `(Autora ran the project's check after you finished that item: \`${r.command}\` passed.)`;
  const unchanged = previous !== undefined && failureKey(previous) !== "" && failureKey(previous) === failureKey(r.output);
  return [
    `(Autora ran the project's check after you marked that item done: \`${r.command}\` ` +
      `${r.exitCode === null ? "did not finish" : `exited ${r.exitCode}`}, so it did not pass.`,
    unchanged
      ? "It fails exactly as it did last time; what you changed since has not affected it."
      : focusOutput(r.output).trim() || "(no output)",
    "That item is not finished while this fails. Fix it now, while the change is fresh, and reopen the item if you marked it done. " +
      "If it fails for a reason that is not yours -- already broken, or the environment -- say so plainly.)",
  ].join("\n");
}

/** What the thread says in a line. */
export function checkLine(r: CheckResult, run: number, tries: number): string {
  if (r.ok) return `The project's check passed (${r.command}).`;
  const how = r.exitCode === null ? "did not finish" : `failed (exit ${r.exitCode})`;
  return run < tries
    ? `The project's check ${how}; the agent was sent back to fix it (${r.command}).`
    : `The project's check is still failing after ${tries} runs (${r.command}).`;
}

/** An entry of the app window's console, as the browser keeps it. */
interface ConsoleEntry {
  kind: "error" | "warn";
  text: string;
  ts: number;
}

/**
 * What the running app says is wrong, once the agent says it has finished.
 *
 * Needs no setting: when the app window is open and the code changed, the page's
 * own console is the check -- an uncaught exception or a failed request after
 * the change is something the agent has not seen, because it wrote code and
 * did not run it. Only errors raised since the change count (an old one is the
 * last version's), the same message once, and warnings are left out. A dev
 * server that has stopped is a problem too.
 */
export function previewProblems(log: readonly ConsoleEntry[], sinceMs: number, serverDown?: { exit?: number | null; last?: string } | null): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const e of log) {
    if (e.kind !== "error" || e.ts < sinceMs) continue;
    const text = e.text.replace(/\s+/g, " ").trim().slice(0, 300);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  if (serverDown) {
    out.push(`The dev server stopped (exit ${serverDown.exit ?? "unknown"})${serverDown.last ? `; it last said: ${serverDown.last}` : ""}.`);
  }
  return out.slice(0, 8);
}

/** What the agent is told when the app it built raised errors. */
export function previewNote(problems: readonly string[], run: number, tries: number): string {
  const left = tries - run;
  return [
    "(Autora looked at the app window after your changes, and the page reported errors:",
    ...problems.map((p) => `- ${p}`),
    left > 0
      ? `Fix them and carry on; it will be looked at again when you are done (${left} more look${left === 1 ? "" : "s"} this turn). ` +
        "Do not say the app works while it is raising errors. If one is not caused by your change, say so.)"
      : "That was the last look this turn. Say plainly that the page still reports errors; do not say the app works.)",
  ].join("\n");
}
