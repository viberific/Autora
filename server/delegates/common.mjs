/**
 * What the two delegate wrappers (claude-call.mjs, gemini-call.mjs) share. A wrapper is what server/vendor.ts runs to hand a
 * job to a subscription CLI; the stream it prints is that file's contract (JSON Lines: delta, status, result, error).
 *
 * Plain Node, no dependencies, so it runs from the image as it is. Each wrapper takes the options vendor.ts passes:
 *   [--jsonl] [--model m] [--effort e] [--cwd dir] [--write] [--timeout t]  ( - | -- prompt... )
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** One line of the stream. */
export const emit = (object) => process.stdout.write(`${JSON.stringify(object)}\n`);

/** Say why it stopped, and stop: exit 1 (failed), as the contract says. */
export function fail(reason, message) {
  emit({ type: "error", reason, message });
  process.exit(1);
}

/** The options vendor.ts passes, and the prompt (from standard input for `-`, else the words after `--`). */
export async function readOptions(argv) {
  const out = { model: "", effort: "", cwd: process.cwd(), write: false, timeoutMs: 0, prompt: "" };
  let fromStdin = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--jsonl") continue;
    else if (a === "--model") out.model = argv[++i] ?? "";
    else if (a === "--effort") out.effort = argv[++i] ?? "";
    else if (a === "--cwd") out.cwd = argv[++i] ?? out.cwd;
    else if (a === "--write") out.write = true;
    else if (a === "--timeout") out.timeoutMs = timeoutMs(argv[++i] ?? "");
    else if (a === "-") fromStdin = true;
    else if (a === "--") { out.prompt = argv.slice(i + 1).join(" "); break; }
    else { process.stderr.write(`unknown option ${a}\n`); process.exit(2); }
  }
  if (fromStdin) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    out.prompt = Buffer.concat(chunks).toString("utf8");
  }
  if (!out.prompt.trim()) { process.stderr.write("no prompt given\n"); process.exit(2); }
  return out;
}

/** "600", "90s", "10m" or "1500ms" as milliseconds; 0 (no limit of its own) for anything else. */
export function timeoutMs(text) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m)?\s*$/i.exec(text);
  if (!m) return 0;
  const n = Number(m[1]);
  const unit = (m[2] ?? "s").toLowerCase();
  return Math.round(unit === "ms" ? n : unit === "m" ? n * 60_000 : n * 1000);
}

/** Where an executable is on PATH, or null. */
export function onPath(name) {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const file = path.join(dir, name);
    try { fs.accessSync(file, fs.constants.X_OK); if (fs.statSync(file).isFile()) return file; } catch { /* not here */ }
  }
  return null;
}

/** Which of the contract's reasons a CLI's own words amount to: a sign-in to make, a wait, or neither. */
export function reasonOf(text) {
  if (/not (?:logged|signed) in|please (?:run|use) \/?login|\/login\b|invalid api key|authenticat|unauthori[sz]ed|credentials|sign in|oauth|\b401\b|\bapi key\b.*(?:missing|required)/i.test(text)) return "auth";
  if (/rate.?limit|usage limit|quota|too many requests|\b429\b|overloaded|resource.?exhausted|limit reached/i.test(text)) return "rate_limit";
  return "other";
}

/** A tool call as one short line for the person watching: "Read src/a.ts", "Bash npm test". */
export function brief(name, input) {
  const bits = input && typeof input === "object" ? input : {};
  const first = bits.file_path ?? bits.path ?? bits.command ?? bits.pattern ?? bits.query ?? bits.url ?? bits.description ?? "";
  const text = typeof first === "string" ? first.replace(/\s+/g, " ").trim() : "";
  return `${name}${text ? ` ${text.length > 80 ? `${text.slice(0, 79)}…` : text}` : ""}`;
}

/**
 * Run the CLI and hand each line of what it prints to `onLine`. Resolves with its exit code and what it said on standard error
 * (the last of it). A limit of time kills it and says so. `AUTORA_DELEGATE_HOME` is where its sign-in lives: the image sets it
 * under /data, which is the one folder that outlives an update, so signing in once is signing in for good.
 */
export function runCli({ bin, args, input, cwd, timeoutMs: limit, onLine }) {
  const env = { ...process.env, NO_COLOR: "1", TERM: "dumb" };
  const home = process.env.AUTORA_DELEGATE_HOME;
  if (home) {
    try { fs.mkdirSync(home, { recursive: true }); env.HOME = home; } catch { /* keep the HOME it has */ }
  }
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      resolve({ code: null, stderr: String(err?.message ?? err), timedOut: false, spawnFailed: true });
      return;
    }
    let stderr = "";
    let timedOut = false;
    let rest = "";
    const timer = limit > 0 ? setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, limit) : null;
    for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => { child.kill("SIGKILL"); process.exit(1); });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      rest += chunk;
      let at;
      while ((at = rest.indexOf("\n")) >= 0) { onLine(rest.slice(0, at)); rest = rest.slice(at + 1); }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4000); });
    child.on("error", (err) => { if (timer) clearTimeout(timer); resolve({ code: null, stderr: String(err?.message ?? err), timedOut: false, spawnFailed: true }); });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (rest) onLine(rest);
      resolve({ code, stderr, timedOut, spawnFailed: false });
    });
    child.stdin.on("error", () => undefined);
    if (input != null) child.stdin.end(input); else child.stdin.end();
  });
}
