/**
 * A terminal command that failed is not run again as it was while nothing has changed since.
 *
 * An agent that sees a command fail often runs it again, word for word, as if the machine might answer differently;
 * then again. Each try is a whole round of the prompt, and the answer is the same. But a hard stop would be wrong:
 * a command can fail, and pass once something else has happened -- the missing package installed, the file fixed,
 * the service started. So a failure stands only while nothing that could change its outcome has happened since:
 *
 *   - a file changed (an edit_file, a file.edit card: the agent's or the person's -- not one the failing command
 *     wrote itself, which it writes again every time);
 *   - another command that changes things ran (anything not read-only: an install, a config, a start);
 *   - a long job was started (run_background), or FORGET_AFTER_MS passed;
 *   - it failed in a way that is often passing (a timeout, the network, a rate limit): one more try is allowed.
 *
 * And the agent can say why it will go differently now (`retry` on the terminal call), when it knows something this
 * cannot see -- the person said they fixed it. Read from the session's own log, so it holds across turns and restarts
 * and needs nothing stored or cleared. Plain code, the same for every model.
 */

import { readOnlyCommand } from "./modes";

interface LogEvent {
  seq: number;
  ts: number;
  kind: string;
  span?: string | null;
  payload?: any;
}

interface StandingFailure {
  command: string;
  /** When it last failed, in seconds (the log's clock). */
  ts: number;
  exit: number | null;
  /** Its last line of output, or the error. */
  why: string;
  /** Times it failed with nothing changed between them. */
  tries: number;
}

/** A failure older than this no longer stands: whatever it depended on (a server, the network) may have moved. */
export const FORGET_AFTER_MS = 10 * 60_000;
/** Failures that often pass on a second try. */
const PASSING = /timed? ?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|temporar|try again|rate.?limit|\b429\b|\b50[234]\b|network|could not resolve|connection (reset|refused)|resource busy|locked|lock file/i;
/** Tools that change files or start work, whatever their result. */
const CHANGES = new Set(["edit_file", "run_background"]);

const keyOf = (command: string, cwd: string) => `${command.trim().replace(/\s+/g, " ")}\u0000${cwd.trim()}`;

/** Every failure that still stands, by command and folder. */
function failuresIn(events: readonly LogEvent[], nowMs: number): Map<string, StandingFailure> {
  const failures = new Map<string, StandingFailure>();
  const calls = new Map<string, { name: string; args: any }>();
  /* Which command each span ran: a file a command wrote itself (a log it appends to, output it leaves) is written
     again on every run, so it is no change that could make that same command go differently. */
  const keyOfSpan = new Map<string, string>();
  for (const e of events) {
    if (e.kind === "file.edit") {
      const own = e.span ? keyOfSpan.get(e.span) : undefined;
      for (const k of [...failures.keys()]) if (k !== own) failures.delete(k);
      continue;
    }
    if (!e.span) continue;
    if (e.kind === "tool.call") {
      const name = String(e.payload?.name ?? "");
      calls.set(e.span, { name, args: e.payload?.args ?? {} });
      // Known from the call, so a file card logged before the result is still the command's own.
      if (name === "terminal") keyOfSpan.set(e.span, keyOf(String(e.payload?.args?.command ?? ""), String(e.payload?.args?.cwd ?? "")));
      continue;
    }
    if (e.kind !== "tool.result" && e.kind !== "tool.error") continue;
    const call = calls.get(e.span);
    if (!call) continue;
    calls.delete(e.span);
    // Ours: a repeat refused here, a call held or declined. Nothing ran, so nothing changed and nothing failed.
    if (e.payload?.repeat || e.payload?.held || e.payload?.denied) continue;
    if (CHANGES.has(call.name)) { failures.clear(); continue; }
    if (call.name !== "terminal") continue;
    const cmd = String(call.args?.command ?? "");
    const key = keyOf(cmd, String(call.args?.cwd ?? ""));
    const exit = e.payload?.display?.exit_code;
    const failed = e.kind === "tool.error" || e.payload?.ok === false || (typeof exit === "number" && exit !== 0);
    /* A command that may change things changes the ground under every other failure, whether it worked or not -- unless
       it never started (not found, not executable), which changed nothing. */
    const neverRan = exit === 127 || exit === 126 || /command not found|not found: |No such file or directory/i.test(String(e.payload?.preview ?? ""));
    if (!readOnlyCommand(cmd) && !(failed && neverRan)) for (const k of [...failures.keys()]) if (k !== key) failures.delete(k);
    if (!failed) { failures.delete(key); continue; }
    const before = failures.get(key);
    failures.set(key, {
      command: cmd.trim(),
      ts: e.ts,
      exit: typeof exit === "number" ? exit : null,
      why: String(e.payload?.preview || e.payload?.error || "").trim().slice(0, 300),
      tries: (before?.tries ?? 0) + 1,
    });
  }
  for (const [k, f] of failures) {
    if (nowMs - f.ts * 1000 > FORGET_AFTER_MS || (PASSING.test(f.why) && f.tries < 2)) failures.delete(k);
  }
  return failures;
}

/** The failure that stands against this exact command in this folder, or null when it may run. */
export function standingFailure(events: readonly LogEvent[], command: string, cwd = "", nowMs = Date.now()): StandingFailure | null {
  return failuresIn(events, nowMs).get(keyOf(command, cwd)) ?? null;
}

/**
 * The turn note's line on them: what failed and would fail again, so a new turn starts knowing it rather than
 * finding out by trying. Null when nothing stands.
 */
export function failuresBriefing(events: readonly LogEvent[], nowMs = Date.now()): string | null {
  const standing = [...failuresIn(events, nowMs).values()].slice(-5);
  if (standing.length === 0) return null;
  return [
    "Commands that failed in this chat and would fail again as they are (nothing has changed since; they will not be " +
      "run unchanged until something does, or a call gives retry with the reason):",
    ...standing.map((f) => `- \`${f.command.slice(0, 160)}\`${f.exit !== null ? ` exit ${f.exit}` : ""}${f.why ? `: ${f.why.slice(0, 140)}` : ""}`),
  ].join("\n");
}

/** What the agent is told instead of the command running again. */
export function repeatRefusal(f: StandingFailure, nowMs = Date.now()): string {
  const ago = Math.max(0, Math.round((nowMs - f.ts * 1000) / 1000));
  const when = ago < 90 ? `${ago} s ago` : `${Math.round(ago / 60)} min ago`;
  return [
    `Not run again: \`${f.command}\` failed ${f.tries > 1 ? `${f.tries} times, last ` : ""}${when}` +
      `${f.exit !== null ? ` (exit ${f.exit})` : ""}${f.why ? `: ${f.why}` : ""}.`,
    "Nothing has changed since that could make it go differently -- no file edited, no other command that changes " +
      "things -- so it would fail the same way. Fix what it reported first (edit the file, install what is missing, " +
      "start what it needs), or run a different command. If you know it will go differently now (the person says they " +
      "fixed it, a service you started is now up), call it again with retry saying why.",
  ].join("\n");
}

/** The line added to a failed command's result, so the lesson is learned on the first failure, not the third. */
export const FAILED_NOTE =
  "[Autora: this command failed. It will not be run again unchanged until something changes -- a file edited, " +
  "another command that changes things -- so look at what it said and change the cause, or try another way.]";
