/**
 * Signing a subscription CLI in from Settings, so a subscription can answer the chat without anyone opening a terminal in the
 * container.
 *
 * Both CLIs sign in the same way when there is no browser beside them: they print a link, the person approves it in their own
 * browser, the page shows a code, and the code is typed back into the CLI. This runs the CLI's own sign-in, hands the link to the
 * page, and types the code the person pastes. Nothing here talks to Anthropic or Google itself, and the token never passes
 * through Autora: each CLI writes its own sign-in under its HOME (AUTORA_DELEGATE_HOME, under /data in the image), where every
 * later turn finds it.
 *
 * - Claude: `claude auth login --claudeai` reads the code from standard input as it is.
 * - Gemini: the `gemini` CLI asks for its code only in an interactive terminal, so it is given one (a pseudo-terminal from
 *   python3, which the image carries). Its auth type is set to "Sign in with Google" first: without that setting even a signed-in
 *   CLI answers "Please set an Auth method".
 *
 * One sign-in per CLI at a time; starting again replaces the one waiting. One that is never finished is stopped after ten
 * minutes. The code is written to the CLI and nowhere else -- not to an event, not to the log.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { cliHome, cliPath, cliSignedIn, geminiCredsFile } from "./clibin";
import { redact, vendorEnv } from "./vendor";

type SignInCli = "claude" | "gemini";

/** The CLI behind a subscription provider, or null for any other provider. */
export function signInCliOf(providerId: string): SignInCli | null {
  return providerId === "claude-cli" ? "claude" : providerId === "gemini-cli" ? "gemini" : null;
}

interface SignInStatus {
  /** The CLI is on this host. */
  installed: boolean;
  signed_in: boolean;
  /** Which program answers: "claude", "gemini", or "agy" where the box has Antigravity's. */
  via: string;
  /** A sign-in waiting for its code, with the link to open. */
  pending: { url: string } | null;
  /** One sentence for the person. */
  detail: string;
}

interface Pending {
  child: ChildProcess;
  url: string;
  output: string;
  exited: boolean;
  code: number | null;
  timer: NodeJS.Timeout;
}

const pending = new Map<SignInCli, Pending>();

/** How long a sign-in may wait for its code before it is stopped. */
const WAIT_MS = 10 * 60_000;

/** A terminal for a program that only asks questions in one: runs argv[1:] in a pseudo-terminal and relays both ways. */
const PTY_RELAY = `
import os, pty, select, signal, sys
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[1], sys.argv[1:])
def stop(*_):
    try: os.kill(pid, signal.SIGKILL)
    except OSError: pass
    os._exit(1)
signal.signal(signal.SIGTERM, stop)
src = sys.stdin.fileno()
reading = True
while True:
    ready, _, _ = select.select([fd] + ([src] if reading else []), [], [])
    if fd in ready:
        try: data = os.read(fd, 65536)
        except OSError: break
        if not data: break
        os.write(1, data)
    if reading and src in ready:
        data = os.read(src, 4096)
        if data: os.write(fd, data)
        else: reading = False
_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status))
`;

/** Terminal colour and cursor codes out, so the link and the prompt can be read from what the CLI printed. */
function plain(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1b[\]P^_][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\r/g, "");
}

/** The sign-in link in what the CLI printed: the vendor's own page, never any other address it happened to mention. */
function linkIn(id: SignInCli, text: string): string | null {
  const hosts = id === "claude" ? /^(?:claude\.com|claude\.ai|console\.anthropic\.com|platform\.claude\.com)$/ : /^accounts\.google\.com$/;
  for (const found of plain(text).match(/https:\/\/[^\s"'<>]+/g) ?? []) {
    try {
      if (hosts.test(new URL(found).hostname)) return found;
    } catch { /* not a URL */ }
  }
  return null;
}

/** The environment a sign-in runs in: the delegates' own (no other service's keys), with HOME where the sign-in is kept. */
function signInEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const home = cliHome();
  try { fs.mkdirSync(home, { recursive: true }); } catch { /* the CLI says so */ }
  return { ...vendorEnv(), HOME: home, ...extra };
}

/** Gemini signs in with Google only once its settings say that is the way; anything else the file holds stays. */
function chooseGoogleSignIn(): void {
  const file = path.join(cliHome(), ".gemini", "settings.json");
  let settings: Record<string, any> = {};
  try { settings = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* none yet, or unreadable: start one */ }
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) settings = {};
  if (settings.security?.auth?.selectedType === "oauth-personal") return;
  settings.security = { ...(settings.security ?? {}), auth: { ...(settings.security?.auth ?? {}), selectedType: "oauth-personal" } };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
}

function stop(id: SignInCli): void {
  const was = pending.get(id);
  if (!was) return;
  pending.delete(id);
  clearTimeout(was.timer);
  if (!was.exited) was.child.kill("SIGKILL");
}

process.once("exit", () => { for (const id of [...pending.keys()]) stop(id); });

/** Ask Claude Code whether it is signed in: its own answer, since a sign-in may live where no file shows it. */
function claudeSignedIn(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    let out = "";
    let child: ChildProcess;
    try {
      child = spawn(bin, ["auth", "status", "--json"], { env: signInEnv(), stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolve(cliSignedIn("claude"));
      return;
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { out += chunk; });
    child.on("error", () => { clearTimeout(timer); resolve(cliSignedIn("claude")); });
    child.on("close", () => {
      clearTimeout(timer);
      try { resolve(JSON.parse(out).loggedIn === true); } catch { resolve(cliSignedIn("claude")); }
    });
  });
}

export async function signInStatus(id: SignInCli): Promise<SignInStatus> {
  const waiting = pending.get(id);
  const open = waiting && !waiting.exited ? { url: waiting.url } : null;
  if (id === "claude") {
    const bin = cliPath("claude");
    if (!bin) {
      return { installed: false, signed_in: false, via: "claude", pending: null, detail: "Claude Code is not installed on this host (npm install -g @anthropic-ai/claude-code)." };
    }
    const signedIn = await claudeSignedIn(bin);
    return { installed: true, signed_in: signedIn, via: "claude", pending: open, detail: signedIn ? "Signed in to Claude." : "Not signed in yet." };
  }
  if (cliPath("agy")) {
    return { installed: true, signed_in: true, via: "agy", pending: null, detail: "Antigravity's agy answers, with its own sign-in." };
  }
  if (!cliPath("gemini")) {
    return { installed: false, signed_in: false, via: "gemini", pending: null, detail: "The Gemini CLI is not installed on this host (npm install -g @google/gemini-cli)." };
  }
  const signedIn = cliSignedIn("gemini");
  return { installed: true, signed_in: signedIn, via: "gemini", pending: open, detail: signedIn ? "Signed in with Google." : "Not signed in yet." };
}

/** Start the CLI's own sign-in and wait for the link it prints. */
export async function startSignIn(id: SignInCli): Promise<{ url: string }> {
  stop(id);
  let child: ChildProcess;
  if (id === "claude") {
    const bin = cliPath("claude");
    if (!bin) throw new Error("Claude Code is not installed on this host.");
    child = spawn(bin, ["auth", "login", "--claudeai"], { env: signInEnv({ BROWSER: "none" }), stdio: ["pipe", "pipe", "pipe"] });
  } else {
    const bin = cliPath("gemini");
    if (!bin) throw new Error("The Gemini CLI is not installed on this host.");
    const python = cliPath("python3");
    if (!python) throw new Error("Signing Gemini in needs python3 on this host, for the terminal the Gemini CLI asks in.");
    chooseGoogleSignIn();
    child = spawn(python, ["-I", "-c", PTY_RELAY, bin], {
      env: signInEnv({ NO_BROWSER: "true", TERM: "xterm-256color", COLUMNS: "400", LINES: "50" }),
      cwd: cliHome(),
      stdio: ["pipe", "pipe", "pipe"],
    });
  }
  const run: Pending = {
    child, url: "", output: "", exited: false, code: null,
    timer: setTimeout(() => stop(id), WAIT_MS),
  };
  pending.set(id, run);
  child.stdin?.on("error", () => undefined);

  return await new Promise<{ url: string }>((resolve, reject) => {
    const give = setTimeout(() => {
      stop(id);
      reject(new Error(`It printed no sign-in link. It said: ${clip(run.output)}`));
    }, 45_000);
    const heard = (chunk: Buffer | string) => {
      run.output = (run.output + String(chunk)).slice(-20_000);
      if (run.url) return;
      const url = linkIn(id, run.output);
      if (url) {
        run.url = url;
        clearTimeout(give);
        resolve({ url });
      }
    };
    child.stdout?.on("data", heard);
    child.stderr?.on("data", heard);
    child.on("error", (err) => {
      run.exited = true;
      clearTimeout(give);
      if (!run.url) { stop(id); reject(new Error(`Could not start the sign-in: ${err.message}`)); }
    });
    child.on("close", (code) => {
      run.exited = true;
      run.code = code;
      if (!run.url) {
        clearTimeout(give);
        stop(id);
        reject(new Error(`The sign-in stopped before it gave a link. It said: ${clip(run.output)}`));
      }
    });
  });
}

/** Type the person's code into the waiting sign-in, and say how it went. */
export async function finishSignIn(id: SignInCli, code: string): Promise<SignInStatus & { ok: boolean }> {
  const run = pending.get(id);
  if (!run || run.exited) {
    stop(id);
    throw new Error("No sign-in is waiting for a code. Start it again.");
  }
  const said = run.output.length;
  run.child.stdin?.write(`${code.trim()}${id === "gemini" ? "\r" : "\n"}`);

  /* Claude's sign-in exits once the code is taken. Gemini's goes on into its chat screen once it has written its sign-in, so the
     file appearing is the sign that it worked. */
  const end = Date.now() + 90_000;
  while (Date.now() < end) {
    if (id === "gemini" && fs.existsSync(geminiCredsFile())) {
      // Written in one go, but given a moment before the CLI is stopped, so it is never stopped half-way through the file.
      await new Promise((r) => setTimeout(r, 750));
      break;
    }
    if (run.exited) break;
    if (id === "gemini" && /failed to authenticate|authorization code is required/i.test(plain(run.output.slice(said)))) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const after = plain(run.output.slice(said));
  stop(id);
  const status = await signInStatus(id);
  const ok = status.signed_in;
  return {
    ...status,
    ok,
    detail: ok ? status.detail : `The sign-in did not finish. ${after.trim() ? `It said: ${clip(after)}` : "Start it again and paste the whole code."}`,
  };
}

function clip(text: string, n = 300): string {
  const one = redact(plain(text)).replace(/\s+/g, " ").trim();
  return one.length > n ? `…${one.slice(-(n - 1))}` : one || "nothing";
}
