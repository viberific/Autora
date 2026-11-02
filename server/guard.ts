/**
 * The tool guard: what is looked at, what stops outright, and how the model is
 * asked about the rest.
 *
 * Two tiers. The narrow one needs no model, no key and no network: a handful
 * of commands nothing can undo always stop and ask the person. Everything else
 * that could plausibly destroy something is put to the model that is already
 * running the turn, once, and stops only when that model says the action is
 * destructive and the person did not ask for it. The model is asked only for
 * calls that pass the cheap filter below, which is rare, so the check costs
 * one short call now and then rather than anything on every turn.
 */

/** Which tool calls are worth asking about. Cheap and deliberately broad: this
    only decides whether to ask the model, never whether to block. */
const RISKY_COMMAND = new RegExp(
  [
    /* Not after a "-": `docker run --rm`, `--kill-after` and `--halt-on-error`
       are flags, not the command, and each false match costs a model call for
       nothing. A path in front (`/bin/rm`) still counts. */
    String.raw`(?<![\w-])(rm|rmdir|shred|dd|mkfs\S*|wipefs|fdisk|parted|truncate|kill|pkill|killall|shutdown|reboot|halt|poweroff|userdel|crontab\s+-r)\b`,
    String.raw`\bsystemctl\s+(stop|disable|mask)\b`,
    String.raw`\bch(mod|own)\s+-R\b`,
    String.raw`\bgit\s+(push\b.*(\s-f\b|--force)|reset\s+--hard|clean\s+-\S*f|branch\s+-D|checkout\s+--\s|restore\b)`,
    String.raw`\bdocker\s+(rm|rmi|system\s+prune|volume\s+(rm|prune)|compose\s+down\s+-v)\b`,
    String.raw`\bkubectl\s+delete\b`,
    String.raw`\b(npm|yarn|pnpm)\s+(publish|unpublish)\b`,
    String.raw`\bterraform\s+(destroy|apply)\b`,
    String.raw`\b(drop\s+(table|database|schema)|truncate\s+table|delete\s+from)\b`,
    String.raw`>\s*/(etc|usr|bin|boot|dev|var)\b`,
    String.raw`\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba)?sh\b`,
  ].join("|"),
  "i",
);

export function guardWorthy(name: string, args: Record<string, any>): boolean {
  /* A background job runs the same command in the same shell, so it is the
     same question: `run_background rm -rf /` must not slip past a guard that
     `terminal rm -rf /` stops at. */
  if (name === "terminal" || name === "run_background") return RISKY_COMMAND.test(String(args.command ?? ""));
  if (name === "http_request") {
    const method = String(args.method ?? "GET").toUpperCase();
    return !["GET", "HEAD", "OPTIONS"].includes(method);
  }
  return false;
}

/* ---- the irrecoverable tier ----------------------------------------------

   RISKY_COMMAND above is only a pre-filter for the model's judgement: it
   decides whether to ask a model, never whether to ask the person, and a
   model that cannot be reached lets the call run. That is right for ordinary
   work -- Autora runs in yolo mode on purpose -- and wrong for the handful of
   commands nothing can undo. So this tier is narrow, and needs no key, no
   model and no network: it matches only damage that is total and permanent. A match stops
   the call and asks the person, on the same card an approval uses; anything
   else runs straight away, exactly as before. */

interface Danger {
  /** What the command would do, in the sentence the card shows. */
  what: string;
  /** The part of the command that matched, so the card can point at it. */
  match: string;
}

/** A word as the shell hands it to the program, and whether it came from inside
    quotes. Quoted text is data: `git commit -m "at 264 the seek"` carries a
    message, and `echo "sleep 120"` prints a number rather than waiting. */
interface Token {
  text: string;
  quoted: boolean;
}

/** The command line split the way the shell splits it: on unquoted newlines and
    operators only, so `git commit -m "a; at 264"` stays one instruction. A
    backslash keeps the character after it literal (out of single quotes), and
    a quote ends at its own kind of quote and nowhere else. */
function scan(text: string): Token[][] {
  const out: Token[][] = [];
  let line: Token[] = [];
  let word = "";
  let quoted = false;
  let quote: "" | "'" | '"' = "";
  const endWord = () => {
    if (word) line.push({ text: word, quoted });
    word = "";
    quoted = false;
  };
  const endLine = () => {
    endWord();
    if (line.length) out.push(line);
    line = [];
  };
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === "\\" && quote !== "'") {
      const next = text[i + 1];
      /* A backslash before a newline continues the line: still one instruction. */
      if (next === "\n") { i += 1; continue; }
      if (next === "\r" && text[i + 2] === "\n") { i += 2; continue; }
      word += next ?? c;
      if (next !== undefined) i += 1;
      continue;
    }
    if (quote) {
      if (c === quote) { quote = ""; continue; }
      word += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; quoted = true; continue; }
    if (c === "\n" || c === "\r" || c === ";") { endLine(); continue; }
    if (c === "&" || c === "|") {
      const doubled = text[i + 1] === c;
      endLine();
      if (doubled) i += 1;
      continue;
    }
    if (c === " " || c === "\t") { endWord(); continue; }
    word += c;
  }
  endLine();
  return out;
}

/** The lines a heredoc feeds a program on stdin are data, not instructions: a
    commit message written through `-F -` may hold a line beginning "at ".
    Handles `<<EOF`, `<<'EOF'`, `<<"EOF"` and `<<-EOF` (leading tabs stripped);
    an unclosed one makes the rest of the command data, as the shell would. */
function withoutHeredocs(command: string): string {
  const lines = command.split(/\r?\n/);
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    kept.push(lines[i]);
    const m = /(^|[^<])<<(-?)[ \t]*(['"]?)([A-Za-z_][\w.-]*)\3/.exec(lines[i]);
    if (!m) continue;
    const stripTabs = m[2] === "-";
    const marker = m[4];
    for (i += 1; i < lines.length; i += 1) {
      const body = stripTabs ? lines[i].replace(/^\t+/, "") : lines[i];
      if (body.trim() === marker) break;
    }
    kept.push("");
  }
  return kept.join("\n");
}

/** The command line as the shell sees it: one instruction per piece, and each
    piece as words the shell would hand over, quote marks removed. A separator
    inside quotes does not split, so `git commit -m "fix: bar hide; at 264"` is
    one instruction. Used by the danger tier, which matches the text of a piece. */
function segments(command: string): string[] {
  return scan(command)
    .map((tokens) => tokens.map((t) => (t.quoted ? `"${t.text.replace(/"/g, '\\"')}"` : t.text)).join(" "))
    .filter(Boolean);
}

/** The same, for the two checks that refuse a call: each piece as words, with
    the heredoc bodies dropped, since what a script is fed on stdin is data. */
function commands(command: string): Token[][] {
  return scan(withoutHeredocs(command));
}

/* ---- timers outside the schedule ------------------------------------------

   An agent's own recurring work is the `schedule` tool, and what it may set there is a script that runs by itself. A
   timer made some other way -- the machine's crontab, `at`, a systemd timer -- is a recurring job nobody can see on the
   Schedule page or pause, and one that starts a model turn each time is the one thing that must not exist unseen: it
   spends tokens for nothing. So the terminal does not make them, and a script that starts a turn is not a script. This
   reads the text of a command, so it is a check on honest mistakes and on the easy way round, not a lock. */

/** Why a command may not be run by an agent: it makes a timer of its own, or calls Autora to start a model turn. */
export function makesTimerOrWake(command: string, scheduled = false): string | null {
  for (const segment of commands(command)) {
    const w = segment.filter((x) => !/^(sudo|env|nice|nohup|time|exec)$/.test(x.text) && !/^\w+=/.test(x.text));
    /* The command is the first word the shell did not take from inside quotes:
       `echo "at now + 1 minute"` prints a sentence, it does not make a job.
       With every word quoted the line still runs something, so the first word
       stands: quoting the command itself makes no timer safer. */
    const unquoted = w.findIndex((x) => !x.quoted);
    if (w.length === 0) continue;
    const start = unquoted === -1 ? 0 : unquoted;
    const first = w[start].text.replace(/^.*\//, "");
    const rest = w.slice(start + 1).map((x) => x.text);
    if (first === "crontab" && !rest.every((x) => x === "-l")) return "a crontab of the machine's own";
    if (first === "at" || first === "batch") return "an `at` job";
    if (first === "systemd-run" || (first === "systemctl" && rest.some((x) => /\.timer\b/.test(x)))) return "a systemd timer";
  }
  if (!scheduled) return null;
  if (/\b(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\]|host\.docker\.internal)(:\d+)?\/(api|ws)\b/i.test(command)) return "a call to Autora's own API, which could start a chat";
  if (/\b(api\.anthropic\.com|api\.openai\.com|generativelanguage\.googleapis\.com|openrouter\.ai|api\.mistral\.ai|api\.groq\.com)\b/i.test(command)) return "a call to a model's API";
  if (/(^|[\s;&|])(claude|codex|gemini|ollama)\s/.test(command)) return "a model's command line";
  return null;
}

/* ---- waiting inside a turn ------------------------------------------------

   A command whose whole job is to wait is the most expensive thing the terminal can be asked to do: it holds the turn
   open for its length, prints nothing, and in this container a long sleep is OOM-killed anyway (the shell is a child of
   a memory-capped server). Measured over 118 sessions, the terminal was called 5,148 times and a good share of the waste
   was a bare `sleep 120` between two reads. A wait longer than ten seconds is refused; short ones, a backgrounded one
   and one that is only part of a longer command are all left alone, so no build or test command is caught by it. */

/** The most a command may wait inside one turn, in seconds. */
export const WAIT_LIMIT_S = 10;

/** A token as seconds: 30, 1.5, 2m, 1h. Null where it is not a plain duration (a variable, an expression). */
function seconds(token: string): number | null {
  const m = /^(\d+(?:\.\d+)?)([smhd]?)$/.exec(token);
  if (!m) return null;
  const n = Number(m[1]);
  return n * (m[2] === "m" ? 60 : m[2] === "h" ? 3600 : m[2] === "d" ? 86400 : 1);
}

/** How long this one segment waits, or null when it does anything but wait. */
function waitOf(tokens: Token[]): number | null {
  const usable = tokens.filter((x) => !PREFIXES.has(x.text) && !/^[A-Za-z_]+=/.test(x.text));
  if (usable.length === 0) return null;
  /* `echo "sleep 120"` prints the words rather than waiting, so a quoted word is
     never the command; a quoted duration (`sleep "120"`) is still a duration. */
  const unquoted = usable.findIndex((x) => !x.quoted);
  const start = unquoted === -1 ? 0 : unquoted;
  const first = usable[start].text.replace(/^.*\//, "");
  const rest = usable.slice(start + 1);
  if (first === "timeout") {
    /* timeout [-s SIG] [-k DUR] DURATION command: the wait is the inner sleep, never the command's own time limit. */
    let args = rest;
    while (args.length && args[0].text.startsWith("-")) {
      const flag = args[0].text;
      args = args.slice(/^-[sk]$/.test(flag) ? 2 : 1);
    }
    if (args.length < 2) return null;
    const limit = seconds(args[0].text);
    const inner = waitOf(args.slice(1));
    if (limit === null || inner === null) return null;
    return Math.min(limit, inner);
  }
  if (first !== "sleep") return null;
  if (rest.length === 0) return 0;
  let total = 0;
  for (const t of rest) {
    const s = seconds(t.text);
    if (s === null) return null;
    total += s;
  }
  return total;
}

/**
 * How many seconds a command only waits for, or null when it does anything at all besides wait. Every segment has to be a
 * wait, so `sleep 60 && curl ...` and `timeout 300 npm test` are ordinary commands; a backgrounded one (`sleep 60 &`)
 * returns at once and is left to run_background, which is what a long job should use anyway.
 */
export function waitsInside(command: string): number | null {
  const text = command.trim();
  if (!text) return null;
  if (/(^|[^&])&\s*$/.test(text)) return null;
  const parts = commands(text);
  if (parts.length === 0) return null;
  let total = 0;
  for (const part of parts) {
    const t = waitOf(part);
    if (t === null) return null;
    total += t;
  }
  return total > WAIT_LIMIT_S ? Math.round(total) : null;
}

/** Where a recursive delete stops being a tidy-up. */
const WHOLE = new Set([
  "/", "/*", "/.", "/*/", "~", "~/", "~/*", "$HOME", "${HOME}", "$HOME/",
  "${HOME}/", "$HOME/*", "*", "/..", "\\/",
]);

/** The top of the machine's own tree, or of this app's: deleting any of these ends the machine or the install. In the
    container the host's filesystem is at /host (so /host/etc is the host's /etc) and Autora's settings, keys and chats
    are in /data. */
const SYSTEM_ROOTS = new Set([
  "etc", "usr", "var", "bin", "sbin", "lib", "lib32", "lib64", "boot", "opt", "srv", "root", "home", "dev", "proc", "sys",
  "mnt", "media", "data",
]);

/** A path that is the whole of the filesystem, a system folder or this app's data, said in any of the ways a shell
    lets you say it (`/etc/`, `/etc/*`, `/host//etc`, `/host`). */
function isSystemPath(token: string): boolean {
  const path = token.replace(/\/+/g, "/").replace(/(\/\.?\*?)+$/, "");
  if (path === "/host") return true;
  const m = /^(?:\/host)?\/([a-z0-9]+)$/.exec(path);
  return !!m && SYSTEM_ROOTS.has(m[1]);
}

/** The words of one piece, each marked with whether it came from inside quotes. */
function words(segment: string): Token[] {
  return scan(segment).flat();
}

/** Words that may stand in front of a command without changing what runs. */
const PREFIXES = new Set(["sudo", "doas", "command", "nice", "time", "env", "nohup", "xargs"]);

/** An `rm` with both the recursive and the force flag, pointed at everything:
    the one form of delete that takes the machine with it. */
function wholeTreeDelete(segment: string): string | null {
  /* The quoted flag is ignored here on purpose: this tier asks rather than
     refuses, and `"rm" -rf /` deletes exactly as much as the bare word. */
  const tokens = words(segment).map((t) => t.text);
  /* The command itself has to be the first thing on the line: `echo 'rm -rf
     /' >> notes` writes that text rather than deleting anything, and a guard
     that holds a shell pipeline naming a file called `rm` is a guard people
     learn to click through. */
  let start = 0;
  while (start < tokens.length && (PREFIXES.has(tokens[start]) || /^[A-Za-z_]+=/.test(tokens[start]))) {
    start += 1;
  }
  const at = tokens[start] === "rm" || (tokens[start] ?? "").endsWith("/rm") ? start : -1;
  if (at === -1) return null;
  let recursive = false;
  let force = false;
  for (const token of tokens.slice(at + 1)) {
    if (token.startsWith("--")) {
      if (token === "--recursive") recursive = true;
      if (token === "--force" || token === "--no-preserve-root") force = true;
      continue;
    }
    if (token.startsWith("-") && token.length > 1) {
      const flags = token.replace(/^-+/, "");
      if (/[rR]/.test(flags)) recursive = true;
      if (/f/.test(flags)) force = true;
      continue;
    }
    if (!recursive || (!force && token !== "--no-preserve-root")) return null;
    return WHOLE.has(token) || isSystemPath(token) ? token : null;
  }
  return null;
}

/** Commands whose damage is total and permanent. Order only matters for
    which one gets reported when a line matches twice. */
const IRRECOVERABLE: { test: (segment: string) => string | null; what: string }[] = [
  {
    what: "format the filesystem on a device",
    test: (s) => /\b(mkfs(\.[a-z0-9]+)?|wipefs|blkdiscard)\b/i.exec(s)?.[0] ?? null,
  },
  {
    what: "write raw data over a disk device",
    test: (s) => /\bdd\b/.test(s)
      ? /\bof=\/dev\/(sd|hd|vd|nvme|mmcblk|disk|loop|dm-)/i.exec(s)?.[0] ?? null
      : null,
  },
  {
    what: "delete the whole filesystem tree",
    test: (s) => wholeTreeDelete(s),
  },
  {
    what: "destroy a Docker volume and the data in it",
    test: (s) => !/\bdocker\b/.test(s) ? null
      : /(\bvolume\s+(rm|prune)\b[^;]*|\bcompose\b[^;]*\bdown\b[^;]*\s(?:-v|--volumes)\b)/i.exec(s)?.[0] ?? null,
  },
  {
    what: "force-push over a shared branch",
    test: (s) => {
      if (!/\bgit\s+push\b/.test(s)) return null;
      const forced = /(--force\b|--force-with-lease\b|(?<=\s)-f\b)/.exec(s);
      if (!forced) return null;
      if (!/\b(main|master)\b/.test(s)) return null;
      return s;
    },
  },
];

/**
 * Whether this call is one the person has to agree to, with no key and no
 * model in the loop. Null for everything else -- which is nearly
 * everything.
 */
export function irreversible(name: string, args: Record<string, any>): Danger | null {
  if (name !== "terminal" && name !== "run_background") return null;
  const command = String(args?.command ?? "");
  if (!command) return null;
  /* Before the split: a fork bomb is made of the separators the split is on. */
  if (/:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/.test(command)) {
    return { what: "fill the machine with copies of itself until nothing else can run", match: ":(){ :|:& };:" };
  }
  for (const segment of segments(command)) {
    for (const rule of IRRECOVERABLE) {
      const match = rule.test(segment);
      if (match) return { what: rule.what, match };
    }
  }
  return null;
}

/* ---- the model's judgement ------------------------------------------------

   For a call that passes the filter but is not in the irrecoverable tier, the
   turn's own model is asked two yes/no questions in one short reply. It holds
   the call only when it says the action is destructive AND the person did not
   ask for it. Anything else -- a reply that cannot be read, a model that
   cannot be reached, a timeout -- lets the call run: this is a second pair of
   eyes on ordinary work, and a guard that stops work whenever it is unsure is
   one people learn to click through. */

/** Asked of the model; it answers with JSON only. */
interface Judgement {
  destructive: boolean;
  requested: boolean;
}

/** How long the model has to answer before the call is let through. */
const JUDGE_TIMEOUT_MS = 20_000;

export const JUDGE_SYSTEM =
  "You check one action an AI agent is about to run on a person's own machine. " +
  "Answer with JSON only, no prose: {\"destructive\": true|false, \"requested\": true|false}. " +
  "destructive is true only if the action could permanently delete, overwrite or break data, " +
  "systems or accounts in a way that cannot easily be undone; routine work -- building, " +
  "testing, cleaning a build folder, restarting something -- is not destructive. " +
  "requested is true if the person's request explicitly asked for this kind of action, " +
  "or plainly implies it (\"delete the old logs\" asks for deleting them); it is false when " +
  "the action goes beyond what was asked. When unsure, answer destructive false.";

export function judgePrompt(input: { request: string; reason: string; tool: string; rendered: string }): string {
  return [
    `The person's request:\n${input.request.slice(0, 1500)}`,
    input.reason ? `The agent's stated reason:\n${input.reason.slice(0, 600)}` : "",
    `The action about to run (${input.tool}):\n${input.rendered.slice(0, 1500)}`,
  ].filter(Boolean).join("\n\n");
}

/** A boolean out of whatever a model wrote for it, or undefined. */
function flag(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const t = value.trim().toLowerCase();
    if (t === "true" || t === "yes") return true;
    if (t === "false" || t === "no") return false;
  }
  return undefined;
}

/** The JSON object in a model's reply, wherever it put it. */
function objectIn(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const body = JSON.parse(text.slice(start, end + 1));
    return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** The two answers, or null unless both were given: half an answer is not one. */
export function parseJudgement(text: string): Judgement | null {
  const body = objectIn(String(text ?? ""));
  if (!body) return null;
  const destructive = flag(body.destructive);
  const requested = flag(body.requested);
  return destructive === undefined || requested === undefined ? null : { destructive, requested };
}

/** Whether the call should be held: destructive, and not what was asked for. */
export function shouldHold(j: Judgement | null): boolean {
  return j !== null && j.destructive && !j.requested;
}

/** The model asked once, with a limit; null when it could not be judged. */
export async function judgeAction(
  ask: (system: string, prompt: string) => Promise<string>,
  input: { request: string; reason: string; tool: string; rendered: string },
  timeoutMs = JUDGE_TIMEOUT_MS,
): Promise<Judgement | null> {
  return asked(ask, JUDGE_SYSTEM, judgePrompt(input), timeoutMs, parseJudgement);
}

/** Whether an action falls under what the person said to ask about. */
const ASK_RULE_SYSTEM =
  "A person told an AI agent when it must stop and ask them before acting. You are shown their " +
  "wording and one action the agent is about to run. Answer with JSON only, no prose: " +
  "{\"ask\": true|false}. ask is true if the action falls under any part of what they said " +
  "to ask about -- read their wording for what they mean, not only the literal words. It is " +
  "false for an action that is unrelated to it. When unsure, answer true.";

function askRulePrompt(input: { rules: string; tool: string; rendered: string }): string {
  return `Ask the person before:\n${input.rules.slice(0, 800)}\n\nThe action about to run (${input.tool}):\n${input.rendered.slice(0, 1500)}`;
}

export function parseAskRule(text: string): boolean | null {
  const body = objectIn(String(text ?? ""));
  const ask = body ? flag(body.ask) : undefined;
  return ask === undefined ? null : ask;
}

/** True unless the model clearly says the action is unrelated: a check that
    cannot be made is a reason to ask the person, not to skip them. */
export async function matchesAskRule(
  ask: (system: string, prompt: string) => Promise<string>,
  input: { rules: string; tool: string; rendered: string },
  timeoutMs = JUDGE_TIMEOUT_MS,
): Promise<boolean> {
  const answer = await asked(ask, ASK_RULE_SYSTEM, askRulePrompt(input), timeoutMs, parseAskRule);
  return answer !== false;
}

/** Whether the person, asked about a held call, said yes. */
const ANSWER_SYSTEM =
  "A person was asked whether an AI agent may run an action. Read their answer. " +
  "Reply with JSON only, no prose: {\"approved\": true|false}. approved is false only " +
  "if they clearly said no or declined; a yes, a go-ahead, or anything ambiguous is true.";

function answerPrompt(rendered: string, said: string): string {
  return `The action:\n${rendered.slice(0, 1000)}\n\nThe person's answer:\n${said.slice(0, 1000)}`;
}

export function parseApproval(text: string): boolean | null {
  const body = objectIn(String(text ?? ""));
  const approved = body ? flag(body.approved) : undefined;
  return approved === undefined ? null : approved;
}

/** True unless the person clearly declined -- and unknown is not a refusal. */
export async function declined(
  ask: (system: string, prompt: string) => Promise<string>,
  rendered: string,
  said: string,
  timeoutMs = JUDGE_TIMEOUT_MS,
): Promise<boolean> {
  const approved = await asked(ask, ANSWER_SYSTEM, answerPrompt(rendered, said), timeoutMs, parseApproval);
  return approved === false;
}

async function asked<T>(
  ask: (system: string, prompt: string) => Promise<string>,
  system: string,
  prompt: string,
  timeoutMs: number,
  parse: (text: string) => T | null,
): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const said = await Promise.race([
      ask(system, prompt),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); }),
    ]);
    return said === null ? null : parse(said);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
