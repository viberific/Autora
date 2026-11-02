/**
 * Handing a job to a subscription CLI (Claude Code, Gemini via Antigravity).
 *
 * This is a *delegate*: a process on this host, signed in as the person, that
 * does the work and talks back. It is not the API -- no key, no per-token bill
 * -- and it is not an agent of the Organization either. What it shares with an
 * agent is that the person should be able to watch it: which vendor was called,
 * what it said while it said it, and whether it touched any files.
 *
 * THE STREAM CONTRACT. A wrapper prints JSON Lines on stdout, one object per
 * line, and exits 0 (worked), 1 (failed) or 2 (bad usage):
 *
 *   {"type":"delta","text":"..."}         a piece of the answer
 *   {"type":"status","text":"reading X"}  what it is doing now
 *   {"type":"result","text":"...",        the finished answer (full text),
 *    "files":["src/a.ts"],                optional: what it edited
 *    "usage":{"input_tokens":1,...}}      optional
 *   {"type":"error","message":"...",      why it stopped
 *    "reason":"rate_limit|auth|timeout|not_installed|other"}
 *
 * A wrapper that has not been taught to stream yet prints the answer once, at
 * the end, as plain text. That is read as a single delta -- so /data/bin/
 * gemini-call.sh works today, unchanged, and starts streaming the day it
 * learns to. A line that is not a JSON object is answer text, which is what
 * makes both shapes work through one path.
 *
 * WHAT NEVER GOES IN. No token, key, cookie or sign-in path is put in an event
 * or a returned summary: everything a wrapper says passes through redact()
 * first, so a CLI that prints its own environment cannot leak the person's
 * credentials into a transcript that is kept on disk.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { redactSecrets } from "./state";

export type VendorId = "claude" | "gemini";

export interface Vendor {
  id: VendorId;
  /** The vendor's own name, as the person would say it. */
  name: string;
  /** What it is: one line, for the model and for a failure the person reads. */
  what: string;
  /** Environment variable that can point somewhere else. */
  env: string;
  /** Where the wrapper lives by default. */
  file: string;
  /** How to get it, when it is missing. Shown in the bubble, so it is a
      sentence the person can act on, not a stack trace. */
  install: string;
}

export const VENDORS: Record<VendorId, Vendor> = {
  claude: {
    id: "claude",
    name: "Claude",
    what: "Claude Code, the subscription CLI signed in on this host",
    env: "AUTORA_CLAUDE_CLI",
    file: "/data/bin/claude-call.sh",
    install: "write /data/bin/claude-call.sh (the JSON Lines contract in server/vendor.ts)",
  },
  gemini: {
    id: "gemini",
    name: "Gemini",
    what: "Gemini through the Antigravity CLI, signed in on this host",
    env: "AUTORA_GEMINI_CLI",
    file: "/data/bin/gemini-call.sh",
    install: "write /data/bin/gemini-call.sh (the JSON Lines contract in server/vendor.ts)",
  },
};

export function vendorPath(id: VendorId): string {
  const set = (process.env[VENDORS[id].env] ?? "").trim();
  return set || VENDORS[id].file;
}

/** Can this vendor be called at all, right now? Cheap: one stat. */
export function vendorReady(id: VendorId): { ok: boolean; path: string; detail: string } {
  const file = vendorPath(id);
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return { ok: true, path: file, detail: `${VENDORS[id].what} (${file})` };
  } catch {
    return {
      ok: false,
      path: file,
      detail:
        `No wrapper at ${file}, so ${VENDORS[id].name} cannot be called from here. ` +
        `To fix it, ${VENDORS[id].install}.`,
    };
  }
}

/* ------------------------------------------------------------- the lines -- */

export type VendorLine =
  | { type: "delta"; text: string }
  | { type: "status"; text: string }
  | { type: "result"; text: string; files: string[]; usage: Record<string, number> | null }
  | { type: "error"; message: string; reason: string };

const REASONS = ["rate_limit", "auth", "timeout", "not_installed", "other"] as const;
export type FailureReason = (typeof REASONS)[number];

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * One line of a wrapper's stdout. Returns null for a line with nothing in it.
 *
 * Anything that is not a JSON object carrying a known `type` is answer text:
 * that is how a wrapper that prints its answer plainly still works.
 */
export function parseLine(raw: string): VendorLine | null {
  const line = raw.replace(/\r$/, "");
  if (!line.trim()) return null;
  let parsed: any = null;
  if (line.trimStart().startsWith("{")) {
    try {
      parsed = JSON.parse(line);
    } catch {
      parsed = null;
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { type: "delta", text: `${line}\n` };
  }
  const type = str(parsed.type);
  if (type === "delta" || type === "text") {
    const text = str(parsed.text);
    return text ? { type: "delta", text } : null;
  }
  if (type === "status") {
    const text = str(parsed.text) || str(parsed.message);
    return text ? { type: "status", text } : null;
  }
  if (type === "result") {
    const files = Array.isArray(parsed.files) ? parsed.files.filter((f: unknown) => typeof f === "string") : [];
    const usage: Record<string, number> = {};
    if (parsed.usage && typeof parsed.usage === "object") {
      for (const [k, v] of Object.entries(parsed.usage)) {
        const n = Number(v);
        if (Number.isFinite(n)) usage[k] = n;
      }
    }
    return { type: "result", text: str(parsed.text) || str(parsed.response), files, usage: Object.keys(usage).length ? usage : null };
  }
  if (type === "error") {
    const reason = REASONS.includes(str(parsed.reason) as FailureReason) ? str(parsed.reason) : "other";
    return { type: "error", message: str(parsed.message) || str(parsed.text) || "the vendor stopped without saying why", reason };
  }
  /* A JSON object with a type nobody defined yet: treat its text as answer
     text rather than dropping what it said. */
  const fallback = str(parsed.text) || str(parsed.response);
  return fallback ? { type: "delta", text: fallback } : null;
}

/** A line splitter that survives a chunk boundary in the middle of a line. */
export function lineSplitter(onLine: (line: string) => void): (chunk: string) => void {
  let held = "";
  return (chunk: string) => {
    held += chunk;
    let cut = held.indexOf("\n");
    while (cut !== -1) {
      const line = held.slice(0, cut);
      held = held.slice(cut + 1);
      onLine(line);
      cut = held.indexOf("\n");
    }
    /* A single line longer than a megabyte is not JSONL any more; take it as
       text so a runaway wrapper cannot hold the whole answer in memory. */
    if (held.length > 1_000_000) {
      onLine(held);
      held = "";
    }
  };
}

/* --------------------------------------------------------------- redacting -- */

const SECRET_LINE =
  /((?:api[-_ ]?key|secret|token|password|passwd|authorization|cookie|bearer)\s*[:=]\s*)(\S+)/gi;
const KEY_PATH = /(\/(?:root|home|data)\/[^\s:]*(?:key|token|credential|secret|\.env)[^\s:]*)/gi;

/**
 * Anything on its way into a bubble, through redact(): the saved secrets the
 * console already knows, then key=value pairs and paths that look like keys.
 * Deliberately blunt -- a redacted word costs nothing, a leaked one cannot be
 * taken back.
 */
export function redact(text: string): string {
  if (!text) return "";
  let out = text;
  try {
    out = redactSecrets(out);
  } catch {
    /* No secret store: the patterns below still run. */
  }
  out = out.replace(SECRET_LINE, "$1[redacted]");
  out = out.replace(KEY_PATH, "[redacted path]");
  return out;
}

/* -------------------------------------------------------------- the run --- */

export interface VendorRunOptions {
  id: VendorId;
  /** What to ask it. */
  prompt: string;
  /** The folder it works in. */
  cwd: string;
  /** Let it edit files and run commands. Off means it only reads. */
  write?: boolean;
  /** Its own timeout, passed through when the wrapper takes one. */
  timeoutArg?: string;
  /** Model and effort, where the wrapper takes them. */
  model?: string;
  effort?: string;
  /** Wall-clock ceiling; the wrapper's own timeout is usually shorter. */
  hardTimeoutMs?: number;
  signal?: AbortSignal;
  /** Called with answer text as it arrives, already coalesced and redacted. */
  onDelta?: (text: string) => void;
  /** Called with what it says it is doing, already redacted. */
  onStatus?: (text: string) => void;
}

export interface VendorRunResult {
  ok: boolean;
  /** Everything it said, redacted. */
  text: string;
  files: string[];
  usage: Record<string, number> | null;
  durationMs: number;
  exitCode: number | null;
  /** Set when it failed, in words the person can act on. */
  reason: FailureReason | null;
  /** Why it failed, one line, redacted. */
  message: string;
  /** It streamed: answer text arrived before it exited. */
  streamed: boolean;
}

/** How long a flush may hold answer text back, and how much may pile up. */
const FLUSH_MS = 120;
const FLUSH_CHARS = 700;

/** How the prompt reaches the wrapper: on stdin (`-`), or as the last word
    after `--`. Wrappers differ, and one that has not been taught stdin says
    so and exits 2 before it does anything -- see runVendor. */
export type PromptForm = "stdin" | "argv";

/** The command line a wrapper is called with: options, then the prompt. */
export function vendorArgs(opts: VendorRunOptions, form: PromptForm = "stdin"): string[] {
  const args: string[] = [];
  if (opts.model) args.push("--model", opts.model);
  if (opts.effort) args.push("--effort", opts.effort);
  if (opts.cwd) args.push("--cwd", opts.cwd);
  if (opts.write) args.push("--write");
  if (opts.timeoutArg) args.push("--timeout", opts.timeoutArg);
  if (form === "stdin") args.push("-");
  else args.push("--", opts.prompt);
  return args;
}

const SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", "__pycache__", ".cache"]);

/** Files under a folder whose mtime is at or after `since`, bounded. */
export function filesTouched(cwd: string, since: number, limit = 4000): string[] {
  const out: string[] = [];
  let seen = 0;
  const walk = (dir: string, depth: number) => {
    if (seen >= limit || depth > 8) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (seen >= limit) return;
      seen += 1;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP.has(entry.name)) continue;
        walk(full, depth + 1);
      } else if (entry.isFile()) {
        try {
          if (fs.statSync(full).mtimeMs >= since - 1000) out.push(full);
        } catch {
          /* Gone between the read and the stat: not an edit worth reporting. */
        }
      }
    }
  };
  walk(cwd, 0);
  return out;
}

const KEEP = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TERM", "TMPDIR", "LANG",
  "NODE_OPTIONS", "NO_COLOR", "TZ", "PWD",
]);
/** What a wrapper legitimately needs: its own vendor's variables, the XDG
    directories it keeps a sign-in in, and anything Autora set on purpose. */
const KEEP_PREFIX = ["AUTORA_", "XDG_", "LC_", "ANTHROPIC_", "CLAUDE_", "GEMINI_", "GOOGLE_", "ANTIGRAVITY_"];

/**
 * The environment a delegate is started with.
 *
 * Not the server's own: Autora's environment holds the person's API keys for
 * other services, and a CLI has no business reading them. What goes through is
 * the shell's own basics, the vendor's own names, and the paths a sign-in is
 * kept in -- which is all a wrapper needs, and less than it could ask for.
 */
export function vendorEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (KEEP.has(key) || KEEP_PREFIX.some((prefix) => key.startsWith(prefix))) env[key] = value;
  }
  env.NO_COLOR = "1";
  env.TERM = "dumb";
  return env;
}

/** A wrapper's exit code and last words, turned into one actionable sentence. */
/** One sentence per failure, because each sends the person to a different
    place: a sign-in, a wait, an install, a shorter ask. */
export function sentenceFor(reason: FailureReason, said = ""): string {
  const also = said ? ` It said: ${clip(said)}` : "";
  switch (reason) {
    case "rate_limit": return `It hit its rate limit or quota.${also}`;
    case "auth": return `It is not signed in any more, or its sign-in expired.${also}`;
    case "timeout": return "It ran out of time and was stopped. A shorter or narrower ask is the way in.";
    case "not_installed": return `The CLI is not installed at that path.${also}`;
    default: return said ? clip(said) : "It stopped without saying why.";
  }
}

/** A wrapper's exit code and last words, turned into one actionable sentence. */
export function failureOf(exitCode: number | null, stderr: string, text: string, timedOut: boolean): {
  reason: FailureReason;
  message: string;
} {
  const said = redact(`${stderr}\n${text}`).trim();
  const low = said.toLowerCase();
  if (timedOut) return { reason: "timeout", message: sentenceFor("timeout", said) };
  if (/rate.?limit|429|quota|overloaded|too many requests|limit reached/.test(low)) {
    return { reason: "rate_limit", message: sentenceFor("rate_limit", said) };
  }
  if (/not signed in|signed out|unauthor|401|403|log ?in|authenticat|credential|api key|expired/.test(low)) {
    return { reason: "auth", message: sentenceFor("auth", said) };
  }
  if (/not installed|command not found|no such file/.test(low)) {
    return { reason: "not_installed", message: sentenceFor("not_installed", said) };
  }
  return {
    reason: "other",
    message: said ? clip(said) : `It stopped with exit code ${exitCode ?? "?"} and said nothing.`,
  };
}

function clip(text: string, n = 400): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

/**
 * Run one wrapper to the end.
 *
 * Resolves rather than throwing: a delegate that failed is a result the bubble
 * reports, never an exception the turn dies on. The caller gets the same shape
 * whether it worked, timed out, or was never installed.
 */
export async function runVendor(opts: VendorRunOptions): Promise<VendorRunResult> {
  const first = await runAttempt(opts, "stdin");
  /* A wrapper whose argument parser takes `-` for an unknown option exits 2
     before spending anything, so asking again with the prompt as the last
     word is free. /data/bin/gemini-call.sh is one of those as it stands. */
  if (!first.ok && first.exitCode === 2 && !first.text && stdinRefused(first.message)) {
    return await runAttempt(opts, "argv");
  }
  return first;
}

/** Was this a wrapper refusing the bare `-`, rather than one of its options? */
export function stdinRefused(message: string): boolean {
  if (!/unknown (option|argument)/i.test(message)) return false;
  return /unknown (option|argument):?\s*-\s*$/im.test(message) || /unknown (option|argument):?\s*-[^-]/.test(message);
}

async function runAttempt(opts: VendorRunOptions, form: PromptForm): Promise<VendorRunResult> {
  const started = Date.now();
  const ready = vendorReady(opts.id);
  const base: VendorRunResult = {
    ok: false, text: "", files: [], usage: null, durationMs: 0,
    exitCode: null, reason: null, message: "", streamed: false,
  };
  if (!ready.ok) {
    return { ...base, reason: "not_installed", message: ready.detail, durationMs: Date.now() - started };
  }
  try {
    fs.mkdirSync(opts.cwd, { recursive: true });
  } catch {
    return {
      ...base, reason: "other", durationMs: Date.now() - started,
      message: `There is no folder to work in at ${opts.cwd}.`,
    };
  }

  let text = "";
  let files: string[] = [];
  let usage: Record<string, number> | null = null;
  let streamed = false;
  let failure: { reason: FailureReason; message: string } | null = null;
  let timedOut = false;
  let stderr = "";
  let buffered = "";
  let flushTimer: NodeJS.Timeout | null = null;

  const flush = () => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (!buffered) return;
    const chunk = buffered;
    buffered = "";
    opts.onDelta?.(chunk);
  };

  const pushDelta = (piece: string) => {
    if (!piece) return;
    text += piece;
    buffered += piece;
    streamed = true;
    if (buffered.length >= FLUSH_CHARS) flush();
    else if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
  };

  return await new Promise<VendorRunResult>((done) => {
    let settled = false;
    const finish = (result: VendorRunResult) => {
      if (settled) return;
      settled = true;
      if (flushTimer) clearTimeout(flushTimer);
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
      done(result);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(ready.path, vendorArgs(opts, form), {
        cwd: opts.cwd,
        env: vendorEnv(),
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err: any) {
      finish({ ...base, reason: "not_installed", message: redact(String(err?.message ?? err)), durationMs: Date.now() - started });
      return;
    }

    const hard = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.hardTimeoutMs ?? 15 * 60_000);

    const onAbort = () => {
      timedOut = false;
      child.kill("SIGKILL");
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    const split = lineSplitter((line) => {
      const parsed = parseLine(line);
      if (!parsed) return;
      if (parsed.type === "delta") pushDelta(redact(parsed.text));
      else if (parsed.type === "status") opts.onStatus?.(redact(parsed.text));
      else if (parsed.type === "result") {
        /* The result carries the whole answer. When text already streamed,
           it is the same answer again and only its files and usage are news;
           when nothing streamed, this is the answer. */
        if (!text) pushDelta(redact(parsed.text));
        if (parsed.files.length) files = parsed.files;
        if (parsed.usage) usage = parsed.usage;
      } else if (parsed.type === "error") {
        failure = { reason: parsed.reason as FailureReason, message: redact(parsed.message) };
      }
    });

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", split);
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      /* Enough to classify a failure, never enough to grow without bound. */
      if (stderr.length < 4000) stderr += chunk;
    });

    child.on("error", (err: any) => {
      clearTimeout(hard);
      finish({
        ...base, reason: "not_installed", durationMs: Date.now() - started,
        message: redact(`Could not start ${ready.path}: ${err?.message ?? err}`),
      });
    });

    child.on("close", (code) => {
      clearTimeout(hard);
      flush();
      const durationMs = Date.now() - started;
      const ok = code === 0 && !timedOut && !failure;
      if (ok) return finish({ ...base, ok: true, text, files, usage, durationMs, exitCode: code, streamed });

      /* An explicit error line gives the reason; what it said is folded into
         the sentence, because the person needs both: which failure it was, and
         the vendor's own words for it. A reason the wrapper calls "other" is
         re-read from what it printed, which is how a 401 it did not label
         still comes out as a sign-in problem. */
      const why = failure
        ? (() => {
          const classified = failureOf(code, stderr, failure.message, timedOut);
          const reason = failure.reason !== "other" ? failure.reason : classified.reason;
          /* What the error line said is what the person needs to read, so it is
             in the sentence even when the wrapper gave no exit-code clue. */
          return { reason, message: sentenceFor(reason, failure.message) };
        })()
        : failureOf(code, stderr, text, timedOut);
      /* What it managed to say before it failed is kept: a timeout halfway
         through an answer is worth more than nothing. */
      finish({
        ...base, ok: false, text, files, usage, durationMs, exitCode: code,
        reason: why.reason, message: why.message, streamed,
      });
    });

    /* The prompt goes in on stdin, so nothing the person asked can be read as
       an option by the wrapper's own argument parser. A wrapper that exits
       without reading it writes EPIPE back, which must not reach the server:
       an unhandled stdin error would take the whole process down mid-turn. */
    child.stdin?.on("error", () => undefined);
    try {
      child.stdin?.end(form === "stdin" ? opts.prompt : "");
    } catch {
      /* The wrapper took no stdin: it will say so on its own. */
    }
  });
}
