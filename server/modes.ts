/**
 * How a chat works, and what it may do without asking. Two separate choices,
 * both made by the person, both per conversation.
 *
 * The WORK MODE is how the agent goes about a task (the selector in the
 * message box):
 *
 *  - build  do the work straight away, as Autora always has.
 *  - plan   read-only. Look, search, browse, and write the plan on the to-do
 *           list; nothing is written, run or sent. The person moves the chat
 *           to Build (or Agent) when the plan is right.
 *  - agent  the default. The agent chooses. Every turn starts in Plan; unless the task is
 *           very simple it investigates and writes the to-do list, then
 *           switches itself to Build and works through it, and back to Plan
 *           if the ground moves under it. The selector stays on Agent: the
 *           switches show in the chat.
 *
 * The PERMISSIONS are what may run without the person's yes (the selector in
 * the header):
 *
 *  - yolo   calls run as they come and are shown as they happen. The guard's
 *           standing agreements and the irrecoverable tier still stop and ask.
 *  - ask    calls that change something wait for a yes on a card, either all
 *           of them or -- when the person wrote down when to ask -- the ones
 *           that fall under what they wrote.
 *
 * Nothing here is a permission the agent can grant itself: both are written by
 * the person and read by the server, and the agent is told what they are.
 */

import { getCustomTool, PREFIX as CUSTOM_PREFIX } from "./customtools";

export type WorkMode = "build" | "plan" | "agent";
export type Permissions = "yolo" | "ask";
/** What the agent is doing right now: the state Agent mode switches between. */
export type Phase = "plan" | "build";

export const DEFAULT_WORK_MODE: WorkMode = "agent";
export const DEFAULT_PERMISSIONS: Permissions = "yolo";

interface ModeInfo<T extends string> {
  id: T;
  /** What the selector says. */
  short: string;
  /** What the menu says. */
  label: string;
  /** One line, for the menu and the settings page. */
  blurb: string;
}

export const WORK_MODES: Record<WorkMode, ModeInfo<WorkMode>> = {
  build: {
    id: "build",
    short: "Build",
    label: "Build",
    blurb: "Does the work straight away, and shows each step as it happens.",
  },
  plan: {
    id: "plan",
    short: "Plan",
    label: "Plan",
    blurb: "Looks, researches and writes a plan. Nothing is changed, run or sent.",
  },
  agent: {
    id: "agent",
    short: "Agent",
    label: "Agent",
    blurb: "Plans first, then builds, switching by itself. Skips the plan for a very simple task.",
  },
};

export const PERMISSION_INFO: Record<Permissions, ModeInfo<Permissions>> = {
  yolo: {
    id: "yolo",
    short: "Yolo",
    label: "Yolo",
    blurb: "Everything runs without asking. Only what can't be undone still stops to ask.",
  },
  ask: {
    id: "ask",
    short: "Ask",
    label: "Ask",
    blurb: "Looking is free. Changes wait for your OK: all of them, or only the ones you name.",
  },
};

export const WORK_MODE_LIST: WorkMode[] = ["build", "plan", "agent"];
export const PERMISSION_LIST: Permissions[] = ["yolo", "ask"];

/** Ideas for "when should it ask", one tap each. The wording is what the
    checking model reads, so each says what it means plainly. */
export const ASK_SUGGESTIONS: { id: string; label: string; rule: string }[] = [
  { id: "delete", label: "Deleting anything", rule: "deleting, overwriting or moving files, records or data" },
  { id: "send", label: "Sending messages", rule: "sending an email, chat message or post to anyone" },
  { id: "spend", label: "Spending money", rule: "spending money: purchases, paid API calls, subscriptions" },
  { id: "install", label: "Installing software", rule: "installing, updating or removing software or packages" },
  { id: "shell", label: "Running commands", rule: "running shell commands" },
  { id: "forms", label: "Forms and sign-ins", rule: "submitting forms, signing in or changing account settings on a website" },
  { id: "outside", label: "Outside the project", rule: "changing anything outside the current project or working folder" },
  { id: "network", label: "Anything that calls out", rule: "making requests that send data to another service" },
];

const ASK_WHEN_MAX = 600;

export function isWorkMode(value: unknown): value is WorkMode {
  return value === "build" || value === "plan" || value === "agent";
}

/** Whatever was stored, as a work mode. An older build wrote plan, ask or
    auto here: plan is still plan, ask was "Build, asking" (see
    legacyPermissions), and auto -- the old default -- is the new one, Agent.
    Anything else must not strand the chat in a mode that does not exist. */
export function workMode(value: unknown): WorkMode {
  if (isWorkMode(value)) return value;
  if (value === "ask") return "build";
  return DEFAULT_WORK_MODE;
}

/** The permissions an older session's mode meant. */
export function legacyPermissions(value: unknown): Permissions {
  return value === "ask" ? "ask" : DEFAULT_PERMISSIONS;
}

export function isPermissions(value: unknown): value is Permissions {
  return value === "yolo" || value === "ask";
}

export function permissionsOf(value: unknown): Permissions {
  return isPermissions(value) ? value : DEFAULT_PERMISSIONS;
}

/** What the person wrote for "ask me when": one tidy paragraph, or nothing. */
export function cleanAskWhen(value: unknown): string {
  return typeof value === "string" ? value.replace(/[ \t]+/g, " ").trim().slice(0, ASK_WHEN_MAX) : "";
}

/** The state the agent is in this turn: fixed by Build and Plan, chosen by the
    agent in Agent -- and plan until it says otherwise. */
export function phaseFor(work: WorkMode, phase: Phase | undefined): Phase {
  if (work === "build") return "build";
  if (work === "plan") return "plan";
  return phase ?? "plan";
}

/**
 * Calls that only look.
 *
 * The list is deliberately short and every entry is deliberate: a tool is here
 * because it cannot change anything outside the console's own record of what
 * it has seen. Opening a page and reading it is looking; filling a form on it
 * is not. Listing the directory is looking; running the command in it is not.
 *
 * A tool that is not on this list is treated as a change, which is the safe
 * way round: a new tool added later is held back until somebody decides it
 * only looks.
 */
const LOOKS_ONLY = new Set([
  "browser_open",
  "browser_read",
  "browser_scroll",
  "browser_screenshot",
  "browser_back",
  "browser_tabs",
  "browser_devtools",
  "browser_captcha",
  "background_jobs",
  "background_output",
  "schedules",
  "pre_authorisations",
  "inventory",
  "memory_search",
  "memory_confirm",
  "code_search",
  "read_file",
  "research",
  "vault_read",
  "artifact_list",
  "artifact_read",
  "mcp_servers",
  "web_search",
  "camera_look",
  "computer_screenshot",
  "speak",
  "widget_show",
  /* Talking to the person, the plan the person watches, and moving between
     planning and building: none changes anything outside the console. Without
     these, Plan would refuse the very calls that make a plan. */
  "ask_user",
  "todo",
  "ledger",
  "requirements",
  "tools_enable",
  "set_mode",
  "browser_handoff",
]);

/** Commands that only read: what a terminal call may run in planning, so the
    agent can look at a file it made (cat, head, ls, grep...) without a way to
    change anything. Anything not here is a change. */
/* Widened at 0.9.304 from the chat logs: planning refused 471 terminal calls in two weeks, most of them reads the old list
   did not know (sed -n 1,80p, git -C <dir> status, git branch -a, diff, test -f), each one a model round trip spent
   being told no. */
const READ_COMMANDS = new Set([
  "cat", "head", "tail", "ls", "tree", "pwd", "wc", "file", "stat", "du", "df", "grep", "egrep", "fgrep", "rg",
  "sort", "uniq", "cut", "tr", "nl", "jq", "realpath", "basename", "dirname", "md5sum", "sha256sum", "sha1sum",
  "strings", "od", "hexdump", "echo", "printf", "date", "which", "whoami", "uname", "ps", "id", "cd", "find",
  "pdftotext", "pdfinfo", "identify", "git",
  "sed", "diff", "cmp", "comm", "tac", "rev", "column", "xxd", "env", "printenv", "test", "[", "true", "false", "seq",
  "uptime", "hostname", "free", "type", "command", "readlink",
]);
const READ_GIT = new Set([
  "status", "log", "diff", "show", "ls-files", "rev-parse", "blame", "describe", "rev-list", "shortlog", "grep", "ls-remote",
  "ls-tree", "cat-file", "merge-base", "whatchanged", "reflog", "for-each-ref", "name-rev",
]);
/** Git subcommands that list when asked only to list, and change something otherwise (`git branch x` makes one). */
const GIT_LISTS: Record<string, (rest: string[]) => boolean> = {
  branch: (r) => r.every((w) => /^(-a|-r|-v|-vv|--all|--remotes|--list|--show-current|--merged|--no-merged|--contains|-l)$/.test(w) || /^--(sort|format)=/.test(w)),
  remote: (r) => r.length === 0 || r.every((w) => w === "-v" || w === "--verbose") || (r[0] === "get-url" && r.length <= 3) || (r[0] === "show" && r.length <= 2),
  tag: (r) => r.length > 0 && (r[0] === "-l" || r[0] === "--list") || (r.length === 0),
  stash: (r) => r[0] === "list" || r[0] === "show",
  worktree: (r) => r[0] === "list",
  config: (r) => r.some((w) => /^(--get|--get-all|--get-regexp|--list|-l)$/.test(w)) && !r.some((w) => /^--(add|unset|replace-all|rename-section|remove-section|edit|-e)$/.test(w)),
};
/** A program asked only for its version (node -v, python3 --version): reading, whatever the program. */
const VERSION_ONLY = /^(node|npm|npx|pnpm|yarn|bun|deno|python3?|pip3?|go|cargo|rustc|java|ruby|php|docker|gh|tsc|git|bash|psql|sqlite3)$/;

/** Whether a shell command only reads: every part of it is a known reading
    command, and nothing writes (no redirect, substitution or in-place flag).
    Doubtful is false: it is then judged as the change it may be. */
export function readOnlyCommand(command: string): boolean {
  const text = command.trim();
  if (!text || text.length > 2000) return false;
  // Redirecting a stream to nowhere, or into the other one, writes nothing.
  const bare = text.replace(/\d?>&\d/g, " ").replace(/\d?>\s*\/dev\/null/g, " ");
  if (/[<>`]|\$\(|\$\{/.test(bare)) return false;
  for (const part of bare.split(/&&|\|\||[;|\n]/)) {
    const words = part.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;
    if (/&/.test(part)) return false;
    const [cmd, ...rest] = words;
    if (rest.length === 1 && /^(-v|-V|--version|version)$/.test(rest[0]!) && VERSION_ONLY.test(cmd!)) continue;
    if (!READ_COMMANDS.has(cmd)) return false;
    /* sed reads only as `sed -n <lines>p` (or `<n>q`): its `w` and `e` commands write files and run programs, and -i
       edits in place, so anything beyond printing a range is a change. */
    if (cmd === "sed") {
      const flags = rest.filter((w) => w.startsWith("-"));
      const script = rest.find((w) => !w.startsWith("-"))?.replace(/^(['"])(.*)\1$/, "$2") ?? "";
      if (flags.some((w) => !/^(-n|--quiet|--silent|-E|-r)$/.test(w)) || !/^((\d+|\$)(,(\d+|\$))?[pq=]|\/[^/]*\/[p=])$/.test(script)) return false;
    }
    // `command -v x` and `type x` say where a program is; `command x` runs it.
    if (cmd === "command" && rest[0] !== "-v" && rest[0] !== "-V") return false;
    // env with an argument runs it (`env FOO=1 make`); printenv only prints.
    if (cmd === "env" && rest.length > 0) return false;
    // xxd -r writes the bytes back out; two files is input and output.
    if (cmd === "xxd" && (rest.some((w) => /^-r|^-revert/.test(w)) || rest.filter((w) => !w.startsWith("-")).length > 1)) return false;
    if ((cmd === "hostname" || cmd === "date") && rest.some((w) => !w.startsWith("-") && !w.startsWith("+"))) return false;
    if (cmd === "git") {
      // `git -C <dir>` and `--no-pager` only say where and how it reads.
      const args = [...rest];
      while (args[0] === "-C" || args[0] === "--no-pager" || args[0]?.startsWith("--git-dir=") || args[0]?.startsWith("--work-tree=")) args.splice(0, args[0] === "-C" ? 2 : 1);
      const sub = args.shift() ?? "";
      // Options that write a file or run another program: a pager, an external diff, a filter, a remote's upload-pack.
      if (rest.some((w) => /^--(output|ext-diff|textconv|filters|exec-path|open-files-in-pager|upload-pack|exec)\b|^-O/.test(w))) return false;
      if (READ_GIT.has(sub)) continue;
      if (GIT_LISTS[sub]?.(args)) continue;
      return false;
    }
    if (cmd === "find" && rest.some((w) => /^-(exec|execdir|ok|okdir|delete|fprint\w*|fls)$/.test(w))) return false;
    if (cmd === "sort" && rest.some((w) => /^-\w*o|^--output/.test(w))) return false;
    /* Commands that read, but take a second file to write to, or a flag that
       runs something: `pdftotext in.pdf out`, `uniq in out`, `rg --pre sh`. */
    const files = rest.filter((w) => w === "-" || !w.startsWith("-"));
    // With no output named it writes <input>.txt beside the PDF: only "-" (standard output) reads.
    if (cmd === "pdftotext" && files[1] !== "-") return false;
    if (cmd === "uniq" && files.length > 1) return false;
    if ((cmd === "rg" || cmd === "grep" || cmd === "egrep" || cmd === "fgrep") && rest.some((w) => /^--(pre|pre-glob|hostname-bin)(=|$)/.test(w))) return false;
    if (cmd === "sort" && rest.some((w) => /^--(compress-program|files0-from)/.test(w))) return false;
    if (cmd === "date" && rest.some((w) => /^(-\w*s|--set)/.test(w))) return false;
    if (cmd === "file" && rest.some((w) => /^(-\w*C|--compile)/.test(w))) return false;
    // ImageMagick reads "ephemeral:" and "msl:" names as instructions (the first deletes the file it reads).
    if (cmd === "identify" && rest.some((w) => /^(-write|-script)|^[a-z]+:/i.test(w) && !/^[a-z]:[\\/]/i.test(w))) return false;
  }
  return true;
}

/** Whether this exact call can change anything. GET and HEAD cannot; a POST
    to somebody's API can, so http_request is judged on its method. */
export function looksOnly(name: string, args: Record<string, any> = {}): boolean {
  if (name === "http_request") {
    const method = String(args.method ?? "GET").toUpperCase();
    return method === "GET" || method === "HEAD" || method === "OPTIONS";
  }
  /* Listing the standing agreements looks; taking one back is a change, and
     is the same tool with an id. */
  if (name === "pre_authorisations") return !String(args.revoke ?? "").trim();
  // Looking at the app window is looking; starting or stopping what it runs is not.
  if (name === "app_preview") return String(args.action ?? "").trim().toLowerCase() === "look";
  // Reading a PDF is looking; pulling its attachments out saves new files.
  if (name === "pdf_read") return !(Array.isArray(args.extract) ? args.extract.length : args.extract);
  if (name === "pdf_look") return true;
  // Reading, checking and the guide look; an edit that is only a dry run looks too.
  if (name === "office_read" || name === "office_check" || name === "office_guide" || name === "office_look" || name === "office_open") return true;
  if (name === "office_edit") return args.dry_run === true;
  // Reading the video project is looking; opening one on the window does not change it, starting a new one does.
  if (name === "video_look" || name === "video_catalog" || name === "video_frame") return true;
  if (name === "video_ui") return String(args.action ?? "") === "read";
  if (name === "video_open") return !String(args.new ?? "").trim();
  // Looking at the picture is looking; opening one on the window does not change it, starting a new one or loading a file does.
  if (name === "photo_look" || name === "photo_info" || name === "photo_commands") return true;
  if (name === "photo_open") return !args.file && !args.new;
  // The same for the music window; playing and stopping change nothing in the song.
  if (name === "studio_look" || name === "studio_play") return true;
  if (name === "studio_open") return !String(args.new ?? "").trim();
  // Looking at the canvas or its library is looking; opening it does not change it, starting a new one does.
  if (name === "panacea_look") return true;
  if (name === "panacea_open") return !String(args.new ?? "").trim();
  // A command that only reads (cat a file, list a folder) is looking.
  if (name === "terminal") return readOnlyCommand(String(args.command ?? ""));
  // Loading a skill's instructions, reading one of its files and searching for one are looking; writing one is not.
  if (name === "skill") return ["use", "read", "list"].includes(String(args.action ?? "").trim().toLowerCase());
  // Reading notebooks is looking; filing into one is not.
  if (name === "notebook") return ["list", "read"].includes(String(args.action ?? "").trim().toLowerCase());
  // Listing the organization and reading Threads look; starting an agent, posting, commenting and liking do not.
  if (name === "agents") return String(args.action ?? "").trim().toLowerCase() === "list";
  if (name === "thread") return ["list", "read"].includes(String(args.action ?? "").trim().toLowerCase());
  // A screenshot kept as a file is a new artifact.
  if (name === "browser_screenshot") return !String(args.save_as ?? "").trim() && !String(args.notebook ?? "").trim();
  return LOOKS_ONLY.has(name);
}

/**
 * What planning says about one call: the sentence the agent is told when the
 * call is refused, or null when it may go ahead. A refusal is not a card --
 * planning is the agent's own state and nobody is being asked -- so the
 * message says what to do instead, in the words that end the round trip.
 */
export function planRefusal(work: WorkMode, phase: Phase | undefined, name: string, args: Record<string, any> = {}): string | null {
  if (phaseFor(work, phase) !== "plan") return null;
  if (looksOnly(name, args)) return null;
  /* A tool the agent wrote and saved as only reading (tool_create reads_only) runs while it plans its own work: its own
     word is enough for its own planning, not for Plan, which the person chose. */
  if (work === "agent" && getCustomTool(name)?.readsOnly === true) return null;
  if (work === "agent") {
    return "Not run: you are planning, and planning changes nothing" +
      (name === "terminal" ? " (a command that only reads -- cat, ls, head, sed -n 1,80p, grep, git status/log/diff/branch -a, diff, test -f -- does run; pdf_look shows a PDF's pages)" : "") +
      (name.startsWith(CUSTOM_PREFIX) && getCustomTool(name) ? ` (${name} is yours: if it only reads, save it again with tool_create reads_only: true and it runs while you plan)` : "") +
      ". Finish the plan on the to-do " +
      "list, then call set_mode with to \"build\" and make this call again. If the task is small " +
      "enough not to need a plan, switch to build now.";
  }
  return "Not run: this chat is in Plan mode, and nothing is changed there" +
    (name === "terminal" ? " (a command that only reads -- cat, ls, head, sed -n 1,80p, grep, git status/log/diff/branch -a, diff, test -f -- does run; pdf_look shows a PDF's pages)" : "") +
    ". Do not retry it and do " +
    "not look for another way to do the same thing. Put what you would do on the to-do list -- the " +
    "files, the commands, the order, the risks -- and say it in your reply, then stop: the person " +
    "moves the chat to Build or Agent when the plan is right.";
}

/**
 * Whether the person's permissions want a word before this call.
 *
 *  - "skip"   it runs (yolo, or a call that only looks);
 *  - "hold"   it waits for a yes, because they asked to be asked about changes
 *             and said nothing narrower;
 *  - "judge"  they named when to ask, so the call is read against that.
 */
export function askAbout(
  permissions: Permissions,
  askWhen: string,
  name: string,
  args: Record<string, any> = {},
): "skip" | "hold" | "judge" {
  if (permissions !== "ask") return "skip";
  if (looksOnly(name, args)) return "skip";
  return cleanAskWhen(askWhen) ? "judge" : "hold";
}

/** What the card says when the permissions held a call. */
export function askReason(askWhen: string): string {
  const when = cleanAskWhen(askWhen);
  return when
    ? `You asked to be asked before: ${when}. This call falls under that.`
    : "This chat is set to Ask: looking is free, and anything that changes something waits for you.";
}

/** The briefing every turn gets about how the chat works. Null when there is
    nothing to add: Build with yolo is what every turn already is. */
export function modeBriefing(
  work: WorkMode,
  phase: Phase | undefined,
  incognito = false,
): string | null {
  const lines: string[] = [];
  if (incognito) lines.push("This chat is incognito: nothing in it is written down.");
  if (work === "plan") {
    lines.push(
      "This chat is in Plan mode, chosen by the person: read-only.",
      "Nothing is to be changed: no file written, no command that changes anything, no message sent, no form submitted. Reading, looking and searching are all allowed, and are usually what the plan needs.",
      "Work out what you would do and put it on the to-do list -- the files you would touch, the commands you would run, the order, what could go wrong -- and say it in your reply. Then stop. A call that would change something is refused as you try it, so trying it costs a round trip; say the plan instead. You cannot leave Plan mode yourself: the person moves the chat to Build or Agent when they are ready.",
    );
  } else if (work === "agent") {
    const now = phaseFor(work, phase);
    lines.push(
      "This chat is in Agent mode, chosen by the person: you plan and build, and you move between the two yourself with the set_mode tool.",
      now === "plan"
        ? "You are PLANNING now. Everything that changes something is refused until you switch to build. Unless the task is very simple, investigate first -- read, look, search -- then write the plan on the to-do list, then call set_mode with to \"build\" and do the work. A very simple task is a question, a lookup or a one-line change: for those, call set_mode with to \"build\" in the same step as the call itself (both in one response, set_mode first), or just answer. If investigating already answers what was asked, that is the whole task: give the answer and stop -- no plan, no switch to build. When in doubt, plan."
        : "You are BUILDING now. Work through the to-do list, keeping it true. If what you find means the plan was wrong, or the work turns out bigger than it looked, call set_mode with to \"plan\", fix the plan, and switch back. Do not ask the person before switching: it is yours to do, and they see each switch in the chat.",
      "Say why in the reason of each switch, in a few words: it is what the person reads.",
    );
  }
  return lines.length ? lines.join("\n") : null;
}

/** What the turn is told about what may run without a yes. Null for yolo. */
export function permissionBriefing(permissions: Permissions, askWhen: string): string | null {
  if (permissions !== "ask") return null;
  const when = cleanAskWhen(askWhen);
  if (!when) {
    return [
      "This chat is set to Ask, chosen by the person: looking runs straight away, and anything that changes something -- a command, an edit, a form, a message -- is held on a card for their yes before it runs.",
      "Say what you are about to do in one line before the call, keep each call to the one thing being asked about, and do not retry something that comes back refused.",
    ].join("\n");
  }
  return [
    `This chat is set to Ask, chosen by the person, with this instruction for when: "${when}".`,
    "Calls that fall under it are held on a card for their yes before they run; everything else runs as usual. Say what you are about to do in one line before such a call, and do not retry something that comes back refused.",
  ].join("\n");
}
