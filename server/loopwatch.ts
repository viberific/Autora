/**
 * Catching an agent that is going round in circles.
 *
 * A turn has no cap on its rounds, so something has to notice when the work
 * has stopped moving: the same command failing the same way, the same page
 * read over and over, two calls taking turns. Asking the model whether it is
 * stuck does not work -- a model in a loop believes each try is the one that
 * will land -- so this watches what it actually does instead.
 *
 * Every call is fingerprinted with its arguments and what came back. A call
 * that has already been made with the same result is a repeat, and repeats
 * get a note appended to the result the model reads, which is the one place
 * it reliably looks. Ignore enough notes and the turn is stopped. Every so
 * many rounds it also gets a checkpoint asking it to measure itself against
 * the goal, with its most repeated calls in front of it.
 */

export interface LoopWatchConfig {
  /** The same call with the same result this many times earns a note. */
  warnAt: number;
  /** ...and this many times stops the turn. */
  stopAt: number;
  /** This many calls in a row with nothing new coming back earns a note. */
  staleAfter: number;
  /** A checkpoint every this many rounds. */
  checkEvery: number;
  /** This many rounds in a row that changed nothing earns a note. */
  stallAfter: number;
  /** ...and this many stall notes in a row, each ignored, stop the turn. */
  stallStops: number;
}

export const LOOP_DEFAULTS: LoopWatchConfig = {
  warnAt: 3,
  stopAt: 8,
  staleAfter: 10,
  checkEvery: 20,
  stallAfter: 8,
  stallStops: 4,
};

/** Rounds in a row of nothing but looking things up before the agent is asked whether it already has its answer. */
export const LOOKUP_ROUNDS = 3;

/** Bookkeeping rides along with any round and says nothing about whether it was a search. */
const NEUTRAL = new Set(["todo", "requirements", "ledger", "set_mode", "memory_write", "memory_search"]);

/**
 * A call that looks something up out in the world: a search, a page read, a fetch. Reading the project's own files
 * is not one -- that is work towards a change, not a hunt for an answer.
 */
export function isLookup(name: string, args: Record<string, any> = {}): boolean {
  if (name === "web_search" || name === "research") return true;
  if (name === "http_request") return ["GET", "HEAD"].includes(String(args.method ?? "GET").toUpperCase());
  if (["browser_open", "browser_read", "browser_scroll", "browser_back", "browser_screenshot", "browser_tabs"].includes(name)) return true;
  // A connected server's fetch or search tool (MCP Fetch, Webclaw).
  return name.startsWith("mcp") && /fetch|webclaw|search|scrape|crawl/i.test(name);
}

interface LoopVerdict {
  /** Appended to what the model reads back from this call. */
  note: string | null;
  /** Said in the thread, once per problem, so the person sees it too. */
  log: string | null;
  /** Set when the turn should end here, with the reason. */
  stop: string | null;
}

/** Key order is not meaning: {a, b} and {b, a} are the same call. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Two results that differ only in a timestamp, a duration or a process id
    are the same result. */
function sameness(ok: boolean, result: string): string {
  const body = result.replace(/\d+/g, "#").replace(/\s+/g, " ").trim().slice(0, 4000);
  return `${ok ? "ok" : "fail"}:${body}`;
}

/** What the person and the model see a call called: its name and a little of
    its arguments. */
export function describe(name: string, args: unknown): string {
  const shown = stable(args);
  if (shown === "{}" || shown === "null") return name;
  return `${name} ${shown.length > 80 ? `${shown.slice(0, 77)}...` : shown}`;
}

export class LoopWatch {
  private readonly config: LoopWatchConfig;
  /** call + result -> how many times. */
  private seen = new Map<string, number>();
  /** call -> how many times it has failed, whatever it said. */
  private failures = new Map<string, number>();
  /** call -> how many times, for the checkpoint's list. */
  private calls = new Map<string, { label: string; count: number }>();
  /** Calls in a row that brought back nothing not already seen. */
  private stale = 0;
  private rounds = 0;
  /** Problems already said in the thread, so each is said once. */
  private logged = new Set<string>();
  /** Exact calls that were repeated after being told not to, and how many
      times they have been refused since. */
  private withheld = new Map<string, { label: string; refused: number }>();
  /** Whether the round in progress changed anything, and how many rounds in a
      row have not. */
  private advanced = false;
  private idleRounds = 0;
  /** Whether the round in progress looked something up, and did nothing else; and how many rounds in a row have. */
  private lookedUp = false;
  private onlyLooked = true;
  private lookupRounds = 0;

  constructor(config: Partial<LoopWatchConfig> = {}) {
    this.config = { ...LOOP_DEFAULTS, ...config };
  }

  /**
   * Before a call runs: refuse the exact call that was repeated after a
   * warning. Cache-safe -- the tool list does not change -- and cheap, since
   * the refusal is one line. Only that call with those arguments is refused:
   * the same tool tried differently is the change of approach being asked for.
   * Refused over and over, the turn is stopped.
   */
  gate(name: string, args: unknown): { refuse: string | null; stop: string | null } {
    const call = `${name}\u0000${stable(args)}`;
    const held = this.withheld.get(call);
    if (!held) return { refuse: null, stop: null };
    held.refused += 1;
    if (held.refused >= REFUSALS_BEFORE_STOP) {
      return {
        refuse: null,
        stop:
          `Stopped: the agent kept calling ${held.label} after it was refused ` +
          `${held.refused - 1} times for repeating itself. Tell it what to try instead.`,
      };
    }
    return {
      refuse:
        `Not run: you have made this exact call, ${held.label}, several times with the same ` +
        "result, and were told to stop. Change something -- the arguments, the tool, the " +
        "assumption behind it -- or tell the person what is blocking you.",
      stop: null,
    };
  }

  /** The call changed something in the world or in what the agent knows. */
  advance() {
    this.advanced = true;
    /* The same command after an edit is ordinary work, not a loop: once
       something has changed, what was refused may be tried again. */
    this.withheld.clear();
  }

  /** One call has run. Says whether it is part of a loop. */
  record(name: string, args: unknown, ok: boolean, result: string): LoopVerdict {
    const { warnAt, stopAt, staleAfter } = this.config;
    const call = `${name}\u0000${stable(args)}`;
    const label = describe(name, args);
    const pair = `${call}\u0000${sameness(ok, result)}`;
    if (isLookup(name, (args ?? {}) as Record<string, any>)) this.lookedUp = true;
    else if (!NEUTRAL.has(name)) this.onlyLooked = false;

    const times = (this.seen.get(pair) ?? 0) + 1;
    this.seen.set(pair, times);
    const tally = this.calls.get(call) ?? { label, count: 0 };
    tally.count += 1;
    this.calls.set(call, tally);
    const failed = ok ? 0 : (this.failures.get(call) ?? 0) + 1;
    if (!ok) this.failures.set(call, failed);
    this.stale = times === 1 ? 0 : this.stale + 1;

    const once = (key: string, message: string) => {
      if (this.logged.has(key)) return null;
      this.logged.add(key);
      return message;
    };

    /* A call that fails the same way is the expensive kind of stuck -- it
       changes nothing and costs a round each time -- so it gets a shorter
       rope than a read that keeps coming back the same. */
    const stopHere = ok ? stopAt : Math.max(warnAt + 1, Math.ceil(stopAt * 0.6));
    if (times >= stopHere) {
      return {
        note: null,
        log: null,
        stop:
          `Stopped: the agent ran ${label} ${times} times and got the same ` +
          "result every time, after being told it was repeating itself. Tell " +
          "it what to try instead, or ask it to explain what is blocking it.",
      };
    }

    /* The note was read and the call was made again anyway. A note is easy to
       skip; from here the exact call is refused (see gate) so the round is
       spent on something else. */
    if (times > warnAt) this.withheld.set(call, { label, refused: 0 });

    if (times >= warnAt) {
      return {
        note:
          `[Loop check] This is the ${ordinal(times)} time you have made this ` +
          "exact call and got the same result. Running it again will not " +
          "change the outcome. Do not repeat it. Work out why it is not " +
          "working and try something genuinely different, or stop and tell " +
          "the person what is blocking you and what you need from them. " +
          `The turn will be stopped if this call repeats ${stopHere - times} ` +
          "more time(s).",
        log: once(`repeat:${pair}`, `Loop check: ${label} has come back the same ${times} times; the agent was told to change approach.`),
        stop: null,
      };
    }

    if (failed >= warnAt) {
      return {
        note:
          `[Loop check] This call has now failed ${failed} times. Small ` +
          "variations of the same attempt are not working. Step back: read " +
          "the error, check your assumptions, and try a different approach, " +
          "or stop and tell the person what is blocking you.",
        log: once(`fail:${call}`, `Loop check: ${label} has failed ${failed} times; the agent was told to step back.`),
        stop: null,
      };
    }

    if (this.stale >= staleAfter) {
      this.stale = 0;
      return {
        note:
          `[Loop check] Your last ${staleAfter} calls all brought back ` +
          "results you had already seen. You are going in circles. Stop and " +
          "compare where you are with the goal. If there is a different way " +
          "forward, take it; if not, stop and tell the person what is " +
          "blocking you.",
        log: once(`stale:${this.seen.size}`, `Loop check: ${staleAfter} calls in a row brought back nothing new; the agent was told it is going in circles.`),
        stop: null,
      };
    }

    return { note: null, log: null, stop: null };
  }

  /**
   * Whether the rounds so far are a stall that notes did not break. A model
   * that varies its arguments every round (a new query, the next offset) is
   * never an exact repeat, and the stall note alone is only a note: without
   * this a turn that ignores it runs, and is billed, until the person
   * notices. Rounds that changed nothing, `stallAfter` times `stallStops`.
   */
  stallStop(): string | null {
    const { stallAfter, stallStops } = this.config;
    if (this.idleRounds < stallAfter * stallStops) return null;
    return (
      `Stopped: ${this.idleRounds} rounds in a row changed nothing, after being told so ${stallStops - 1} times. ` +
      "Tell the agent what to look for, or what to do instead."
    );
  }

  /**
   * What a stop taught, as a memory the next chat on the same work is told: what
   * was asked, why it was stopped, and the calls that went round. The error
   * budget writes its own for a stop it made (ErrorBudget.deadEnd); this is for
   * the rest -- a repeated call, a stall, a call refused over and over. Null when
   * nothing was repeated, since then there is no path to warn against.
   */
  deadEnd(request: string, reason: string): { title: string; body: string; tags: string[] } | null {
    const repeated = [...this.calls.values()]
      .filter((c) => c.count >= 2)
      .sort((a, b) => b.count - a.count)
      .slice(0, 5)
      .map((c) => `${c.label} (x${c.count})`);
    if (!repeated.length) return null;
    const asked = request.replace(/\s+/g, " ").trim();
    const topic = asked.length > 70 ? `${asked.slice(0, 67)}...` : asked;
    return {
      title: `Dead end: ${topic}`.slice(0, 200),
      body:
        `Working on "${asked.slice(0, 300)}", the turn went round in circles and was stopped (${reason.replace(/^Stopped: /, "").slice(0, 200)}). ` +
        `What was repeated without getting anywhere: ${repeated.join("; ")}. Do not start this way again: find the cause first, ` +
        "try another route, or ask the person.",
      tags: ["dead-end", ...new Set([...this.calls.values()].map((c) => c.label.split(/[\s(]/)[0]).slice(0, 3))],
    };
  }

  /** One round of calls is done. Every so often, a checkpoint. */
  endRound(): string | null {
    this.rounds += 1;
    this.idleRounds = this.advanced ? 0 : this.idleRounds + 1;
    this.advanced = false;
    this.lookupRounds = this.lookedUp && this.onlyLooked ? this.lookupRounds + 1 : 0;
    this.lookedUp = false;
    this.onlyLooked = true;
    if (this.idleRounds > 0 && this.idleRounds % this.config.stallAfter === 0) {
      return (
        `[Stall] The last ${this.idleRounds} rounds changed nothing: no file written, ` +
        "no command with an effect, no plan or notes updated. If you have what you need, " +
        "answer now. If you are still searching, say what you are looking for and why " +
        "the last searches did not find it, then try a different way of looking."
      );
    }
    /* A search that found the answer and kept going: each new query is a different call, so nothing above sees it,
       and the stall note comes eight rounds in. Asked early, and again every few rounds while it goes on. */
    if (this.lookupRounds > 0 && this.lookupRounds % LOOKUP_ROUNDS === 0) {
      return (
        `[Answer check] The last ${this.lookupRounds} rounds were all looking things up. Before another search, ` +
        "read back what you have: if it already answers what the person asked, stop searching and answer now. " +
        "A second source that agrees with a good first one is not needed unless the person asked for it or the " +
        "sources disagree. Search again only for one specific fact that is still missing, and say which."
      );
    }
    if (this.rounds % this.config.checkEvery !== 0) return null;
    const repeated = [...this.calls.values()]
      .filter((c) => c.count >= 3)
      .sort((a, b) => b.count - a.count)
      .slice(0, 5)
      .map((c) => `${c.label} (x${c.count})`);
    return (
      `[Checkpoint] ${this.rounds} rounds of tool calls so far in this turn. ` +
      "Before the next call, check yourself against the person's request: " +
      "what is done, what is left, and whether the last few rounds actually " +
      "moved you forward. If they did not, change approach or stop and report." +
      (repeated.length > 0 ? ` Your most repeated calls: ${repeated.join(", ")}.` : "")
    );
  }
}

/** Refusals of one repeated call before the turn is stopped. */
const REFUSALS_BEFORE_STOP = 4;

function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}
