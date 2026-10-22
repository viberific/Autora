/**
 * An action that failed is not done again, exactly as it was, while nothing has changed since.
 *
 * An agent that sees a call fail often makes it again, word for word, as if the machine might answer differently:
 * the same command, the same click on an element that is not there, the same edit whose text is not in the file, the
 * same request to a server that refused it. Each try is a whole round of the prompt, and the answer is the same. But
 * a hard stop would be wrong: a call can fail and pass once something else has happened -- the package installed,
 * the file fixed, the page loaded. So a failure stands only while nothing that could change its outcome has happened:
 *
 *   - a file changed (an edit, a file card: the agent's or the person's -- not one the failing command wrote itself,
 *     which it writes again every time);
 *   - another call that changes things was made (anything that does not only look, `looksOnly`; a command that never
 *     started, not found or not executable, changed nothing);
 *   - for the browser, any browser call that worked: the page may be another one now, and looking at it again is how
 *     the agent finds out; and BROWSER_FORGET_MS, since a page loads by itself;
 *   - FORGET_AFTER_MS, for everything else;
 *   - it failed in a way that often passes (a timeout, the network, a rate limit): one more try is allowed.
 *
 * The same tool with other arguments is another call. And the agent can say why this time is different (`retry` on
 * any call: the person said they fixed it), which the loop takes off the arguments before the tool sees them.
 *
 * Read from the session's own log, so it holds across turns and restarts and needs nothing stored or cleared. Plain
 * code, the same for every model.
 */

import { describe } from "./loopwatch";
import { looksOnly, readOnlyCommand } from "./modes";

interface LogEvent {
  seq: number;
  ts: number;
  kind: string;
  span?: string | null;
  payload?: any;
}

interface StandingFailure {
  name: string;
  args: Record<string, any>;
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
/** A page changes by itself as it loads; a failed click or fill stands this long at most. */
export const BROWSER_FORGET_MS = 60_000;
/** Failures that often pass on a second try. */
const PASSING = /timed? ?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|temporar|try again|rate.?limit|\b429\b|\b50[234]\b|network|could not resolve|connection (reset|refused)|resource busy|locked|lock file/i;
/* Calls whose failing is waiting, not a mistake (a job still running, a question), or that are the console's own
   bookkeeping: never held back. */
const NEVER_HELD = new Set(["ask_user", "background_output", "background_jobs", "todo", "requirements", "ledger", "set_mode", "speak", "voice_mute"]);
const isBrowser = (name: string) => name.startsWith("browser_");

/** The call as compared: the tool and its arguments, minus `retry`, a terminal command with its spacing evened out. */
function keyOf(name: string, args: Record<string, any> = {}): string {
  const { retry: _retry, ...rest } = args ?? {};
  if (name === "terminal") return `terminal\u0000${String(rest.command ?? "").trim().replace(/\s+/g, " ")}\u0000${String(rest.cwd ?? "").trim()}`;
  return `${name}\u0000${describe("", rest)}`;
}

/** Every failure that still stands, by call. */
function failuresIn(events: readonly LogEvent[], nowMs: number): Map<string, StandingFailure> {
  const failures = new Map<string, StandingFailure>();
  const calls = new Map<string, { name: string; args: any }>();
  /* Which call each span made: a file a command wrote itself (a log it appends to) is written again on every run, so
     it is no change that could make that same command go differently. */
  const keyOfSpan = new Map<string, string>();
  const clearAllBut = (keep?: string, only?: (f: StandingFailure) => boolean) => {
    for (const [k, f] of failures) if (k !== keep && (!only || only(f))) failures.delete(k);
  };
  for (const e of events) {
    if (e.kind === "file.edit") {
      clearAllBut(e.span ? keyOfSpan.get(e.span) : undefined);
      continue;
    }
    if (!e.span) continue;
    if (e.kind === "tool.call") {
      const name = String(e.payload?.name ?? "");
      const args = e.payload?.args ?? {};
      calls.set(e.span, { name, args });
      keyOfSpan.set(e.span, keyOf(name, args));
      continue;
    }
    if (e.kind !== "tool.result" && e.kind !== "tool.error") continue;
    const call = calls.get(e.span);
    if (!call) continue;
    calls.delete(e.span);
    // Ours: a repeat refused here, a call held, declined or refused while planning. Nothing ran.
    if (e.payload?.repeat || e.payload?.held || e.payload?.denied || e.payload?.planning) continue;
    const key = keyOf(call.name, call.args);
    const exit = e.payload?.display?.exit_code;
    const failed = e.kind === "tool.error" || e.payload?.ok === false || (typeof exit === "number" && exit !== 0);
    const why = String(e.payload?.preview || e.payload?.error || "").trim();
    /* A call that may change things changes the ground under every other failure, whether it worked or not -- unless
       it never started (not found, not executable), which changed nothing. */
    const neverRan = call.name === "terminal" && failed &&
      (exit === 127 || exit === 126 || /command not found|not found: |No such file or directory/i.test(why));
    const changes = call.name === "terminal" ? !readOnlyCommand(String(call.args?.command ?? "")) : !looksOnly(call.name, call.args ?? {});
    if (changes && !neverRan) clearAllBut(key);
    // A browser call that worked: the page may be another one now, so no failed click or fill on it still stands.
    if (!failed && isBrowser(call.name)) clearAllBut(key, (f) => isBrowser(f.name));
    if (!failed) { failures.delete(key); continue; }
    if (NEVER_HELD.has(call.name)) continue;
    const before = failures.get(key);
    failures.set(key, {
      name: call.name,
      args: call.args ?? {},
      ts: e.ts,
      exit: typeof exit === "number" ? exit : null,
      why: why.slice(0, 300),
      tries: (before?.tries ?? 0) + 1,
    });
  }
  for (const [k, f] of failures) {
    const forget = isBrowser(f.name) ? BROWSER_FORGET_MS : FORGET_AFTER_MS;
    if (nowMs - f.ts * 1000 > forget || (PASSING.test(f.why) && f.tries < 2)) failures.delete(k);
  }
  return failures;
}

/** The failure that stands against this exact call, or null when it may go ahead. */
export function standingFailure(events: readonly LogEvent[], name: string, args: Record<string, any> = {}, nowMs = Date.now()): StandingFailure | null {
  if (NEVER_HELD.has(name)) return null;
  return failuresIn(events, nowMs).get(keyOf(name, args)) ?? null;
}

/** How a call is named to the agent: a command as it was typed, anything else as the tool and its arguments. */
function shown(f: Pick<StandingFailure, "name" | "args">): string {
  return f.name === "terminal" ? String(f.args?.command ?? "").trim() : describe(f.name, Object.fromEntries(Object.entries(f.args ?? {}).filter(([k]) => k !== "retry")));
}

/** What the agent is told instead of the call being made again. */
export function repeatRefusal(f: StandingFailure, nowMs = Date.now()): string {
  const ago = Math.max(0, Math.round((nowMs - f.ts * 1000) / 1000));
  const when = ago < 90 ? `${ago} s ago` : `${Math.round(ago / 60)} min ago`;
  const instead = f.name === "terminal"
    ? "Fix what it reported first (edit the file, install what is missing, start what it needs), or run a different command."
    : isBrowser(f.name)
      ? "Look at the page as it is now (browser_read) and act on what is there, or do something else."
      : "Change what it depends on, or the arguments, or do it another way.";
  return [
    `Not done again: \`${shown(f).slice(0, 200)}\` failed ${f.tries > 1 ? `${f.tries} times, last ` : ""}${when}` +
      `${f.exit !== null ? ` (exit ${f.exit})` : ""}${f.why ? `: ${f.why}` : ""}.`,
    `Nothing has changed since that could make it go differently, so it would fail the same way. ${instead} ` +
      "If you know it will go differently now (the person says they fixed it, something you started is now ready), make " +
      "the same call with retry saying why.",
  ].join("\n");
}

/** The line added to a failed call's result, so the lesson is learned on the first failure, not the third. */
export const FAILED_NOTE =
  "[Autora: this failed. The same call will not be made again unchanged until something changes -- a file edited, " +
  "another action that changes things -- so read what it said and change the cause, or try another way.]";

/** Whether a call's failure gets FAILED_NOTE (and can be held back at all). */
export const holdsBack = (name: string): boolean => !NEVER_HELD.has(name);

/**
 * The turn note's line on them: what failed and would fail again, so a new turn starts knowing it rather than finding
 * out by trying. Null when nothing stands.
 */
export function failuresBriefing(events: readonly LogEvent[], nowMs = Date.now()): string | null {
  const standing = [...failuresIn(events, nowMs).values()].slice(-6);
  if (standing.length === 0) return null;
  return [
    "Actions that failed in this chat and would fail again as they are (nothing has changed since; they will not be " +
      "repeated unchanged until something does, or a call gives retry with the reason):",
    ...standing.map((f) => `- \`${shown(f).slice(0, 160)}\`${f.exit !== null ? ` exit ${f.exit}` : ""}${f.why ? `: ${f.why.slice(0, 140)}` : ""}`),
  ].join("\n");
}
