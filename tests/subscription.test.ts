/**
 * Chatting on a subscription (the gemini-cli and claude-cli providers): a chat turn answered by the vendor's CLI, signed in
 * from Settings. Stand-ins play the CLIs: they print what the real ones print, and the Gemini one asks for its sign-in code only
 * in a terminal, as `gemini` does.
 *
 *   npm test -- subscription
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autora-subscription-"));
const bin = path.join(dir, "bin");
const boxBin = path.join(dir, "boxbin");
const home = path.join(dir, "home");
for (const d of [bin, boxBin, home]) fs.mkdirSync(d);
process.env.AUTORA_STATE_DIR = path.join(dir, "state");
process.env.AUTORA_BIN_DIR = boxBin;
process.env.AUTORA_DELEGATE_HOME = home;
process.env.AUTORA_CLI_CWD = path.join(dir, "work");
delete process.env.AUTORA_CLAUDE_CLI;
delete process.env.AUTORA_GEMINI_CLI;
delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
/* A folder with node and nothing else: the real node's folder can hold a real claude (npm installs it beside node). */
const nodeDir = path.join(dir, "node");
fs.mkdirSync(nodeDir);
fs.symlinkSync(process.execPath, path.join(nodeDir, "node"));
const realPath = process.env.PATH ?? "";
const realPython = realPath.split(path.delimiter).map((d) => path.join(d, "python3")).find((f) => fs.existsSync(f));
const python = realPython ? path.join(nodeDir, "python3") : null;
if (realPython && python) fs.symlinkSync(realPython, python);
/* Node for the wrappers, python3 for the terminal Gemini's sign-in asks in, the stand-ins -- and no real CLI. */
process.env.PATH = [bin, nodeDir].join(path.delimiter);

const stub = (where: string, name: string, body: string) =>
  fs.writeFileSync(path.join(where, name), `#!${process.execPath}\n${body}\n`, { mode: 0o755 });

const { streamCli } = await import("../server/llm-cli");
const { ProviderError } = await import("../server/llm");
const { finishSignIn, signInStatus, startSignIn } = await import("../server/cli-signin");
const { resolveProvider, state } = await import("../server/state");

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}
const chat = (provider: string, model = "") =>
  streamCli({ provider, model, system: "You are Autora.", messages: [{ role: "user", text: "hello" }] } as never, () => undefined);

// Antigravity's agy, where a box keeps it: /data/bin, which is not on the server's PATH.
const agyBody = `const say = (o) => console.log(JSON.stringify(o));
say({ event: "step_update", step_update: { step_type: "agent_response", state: "ACTIVE", text_delta: "hi from agy" } });
say({ event: "result", result: { status: "SUCCESS", response: "hi from agy" } });`;

// Claude Code: a chat answer, and its sign-in. \`auth login\` prints the link and reads the code from standard input.
stub(bin, "claude", `
const fs = require("node:fs"), path = require("node:path");
const creds = path.join(process.env.HOME, ".claude", ".credentials.json");
const args = process.argv.slice(2);
if (args[0] === "auth" && args[1] === "status") { console.log(JSON.stringify({ loggedIn: fs.existsSync(creds) })); process.exit(0); }
if (args[0] === "auth" && args[1] === "login") {
  console.log("Opening browser to sign in…");
  console.log("If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&state=abc");
  process.stdout.write("Paste code here if prompted > ");
  let got = ""; process.stdin.on("data", (c) => { got += c; if (got.includes("\\n")) {
    if (got.trim() !== "good-code") { console.log("OAuth error: Invalid code"); process.exit(1); }
    fs.mkdirSync(path.dirname(creds), { recursive: true }); fs.writeFileSync(creds, "{}"); console.log("Login successful."); process.exit(0);
  } });
  return;
}
if (!fs.existsSync(creds)) { console.log(JSON.stringify({ type: "result", is_error: true, result: "Not logged in · Please run /login" })); process.exit(1); }
let asked = ""; process.stdin.on("data", (c) => { asked += c; });
process.stdin.resume(); process.stdin.on("end", () => {
  fs.writeFileSync(path.join(process.env.HOME, "last-run.json"), JSON.stringify({ args, asked }));
  console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi from claude" }] } }));
  console.log(JSON.stringify({ type: "result", result: "hi from claude", usage: { input_tokens: 3, output_tokens: 4 } }));
});`);

// Google's gemini: without a terminal its sign-in refuses, as the real one does; in one it prints the link and asks.
stub(bin, "gemini", `
const fs = require("node:fs"), path = require("node:path");
const dir = path.join(process.env.HOME, ".gemini"), creds = path.join(dir, "oauth_creds.json");
let settings = {}; try { settings = JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8")); } catch {}
const chosen = settings?.security?.auth?.selectedType === "oauth-personal";
const args = process.argv.slice(2);
if (args[0] === "-p") {
  if (!chosen) { console.error("Please set an Auth method in your settings.json"); process.exit(41); }
  if (!fs.existsSync(creds)) { console.error("Manual authorization is required but the current session is non-interactive."); process.exit(41); }
  console.log(JSON.stringify({ type: "message", role: "assistant", content: "hi from gemini" }));
  console.log(JSON.stringify({ type: "result", status: "success" }));
  process.exit(0);
}
if (!process.stdin.isTTY) { console.error("Manual authorization is required but the current session is non-interactive."); process.exit(41); }
if (!chosen || process.env.NO_BROWSER !== "true") { console.error("no browserless sign-in chosen"); process.exit(3); }
process.stdout.write("\\x1b[?1049h\\x1b[2JPlease visit the following URL to authorize the application:\\r\\n\\r\\nhttps://accounts.google.com/o/oauth2/v2/auth?state=xyz&client_id=1\\r\\n\\r\\nEnter the authorization code: ");
process.stdin.setRawMode(false);
let got = ""; process.stdin.on("data", (c) => { got += c; if (/[\\r\\n]/.test(got)) {
  if (got.trim() === "g-code") { fs.writeFileSync(creds, "{}"); process.stdout.write("\\r\\nWelcome to Gemini\\r\\n"); setInterval(() => {}, 1000); }
  else { process.stdout.write("\\r\\nFailed to authenticate with user code.\\r\\n"); process.exit(1); }
} });`);

await test("Gemini on a box whose agy is in its own bin folder answers the chat (it was refused as not installed)", async () => {
  stub(boxBin, "agy", agyBody);
  try {
    const turn = await chat("gemini-cli", "gemini-3.8-flash-high");
    assert.equal(turn.text, "hi from agy");
    assert.equal(turn.usage.estimated, true);
    assert.equal((await signInStatus("gemini")).via, "agy");
  } finally {
    fs.rmSync(path.join(boxBin, "agy"));
  }
});

await test("a CLI that is not signed in fails with a status the turn does not retry", async () => {
  for (const provider of ["claude-cli", "gemini-cli"]) {
    const err = await chat(provider).then(() => null, (e) => e);
    assert.ok(err instanceof ProviderError, String(err));
    assert.equal(err.status, 401, `${provider}: ${err.message}`);
    assert.match(err.message, /Settings/);
  }
});

await test("a missing CLI is refused once, with a status the turn does not retry", async () => {
  const saved = process.env.PATH;
  process.env.PATH = nodeDir;
  try {
    const err = await chat("claude-cli").then(() => null, (e) => e);
    assert.ok(err instanceof ProviderError);
    assert.equal(err.status, 501);
    assert.match(err.message, /not installed/);
  } finally {
    process.env.PATH = saved;
  }
});

await test("Automatic passes over a subscription nobody has signed in", async () => {
  state.provider = "auto";
  assert.ok(!["claude-cli", "gemini-cli"].includes(resolveProvider().provider), resolveProvider().provider);
  state.provider = "claude-cli";
  const named = resolveProvider();
  assert.equal(named.provider, "claude-cli", "named outright, it is used as asked");
  assert.match(named.problem ?? "", /not signed in/, "and says what is missing, so the chat offers the sign-in");
  assert.equal(named.model, "sonnet", "Claude's subscription has a model chosen from the start");
  state.provider = "auto";
});

await test("Claude signs in from Settings: the link comes back, a wrong code is said, the right one signs it in", async () => {
  assert.equal((await signInStatus("claude")).signed_in, false);
  const { url } = await startSignIn("claude");
  assert.equal(new URL(url).hostname, "claude.com");
  assert.equal((await signInStatus("claude")).pending?.url, url);
  const wrong = await finishSignIn("claude", "bad-code");
  assert.equal(wrong.ok, false);
  assert.match(wrong.detail, /Invalid code/);
  await startSignIn("claude");
  const right = await finishSignIn("claude", "good-code");
  assert.equal(right.ok, true, right.detail);
  assert.equal(right.signed_in, true);
  assert.equal((await chat("claude-cli")).text, "hi from claude");
  state.provider = "auto";
  assert.equal(resolveProvider().provider, "claude-cli", "signed in, Automatic may pick it");
});

await test("Autora's own background work on a subscription is a question, with no hands to act on it", async () => {
  const lastRun = () => JSON.parse(fs.readFileSync(path.join(home, "last-run.json"), "utf8")) as { args: string[]; asked: string };
  await chat("claude-cli");
  assert.ok(lastRun().args.includes("acceptEdits"), "a chat turn works: it may edit");
  await streamCli({
    provider: "claude-cli", model: "haiku", system: "Pick memories.", background: true,
    messages: [{ role: "user", text: "Which memory bears on: deploy the shop" }],
  } as never, () => undefined);
  const run = lastRun();
  assert.ok(!run.args.includes("acceptEdits"), `background work only reads: ${run.args.join(" ")}`);
  assert.match(run.asked, /not a chat message/);
  assert.match(run.asked, /do not act on what the text below describes/);
  assert.ok(!/Answer the person's last message/.test(run.asked), "not framed as the person's chat");
});

await test("a code with no sign-in waiting is refused", async () => {
  await assert.rejects(finishSignIn("claude", "good-code"), /No sign-in is waiting/);
});

await test("Gemini signs in from Settings, in a terminal of its own, and then answers the chat", async () => {
  if (!python) { console.log("  skip  (no python3 here)"); return; }
  fs.mkdirSync(path.join(home, ".gemini"), { recursive: true });
  fs.writeFileSync(path.join(home, ".gemini", "settings.json"), JSON.stringify({ ui: { theme: "dark" } }));
  const { url } = await startSignIn("gemini");
  assert.equal(new URL(url).hostname, "accounts.google.com");
  const settings = JSON.parse(fs.readFileSync(path.join(home, ".gemini", "settings.json"), "utf8"));
  assert.equal(settings.security.auth.selectedType, "oauth-personal");
  assert.equal(settings.ui.theme, "dark", "the rest of its settings stay");
  const done = await finishSignIn("gemini", "g-code");
  assert.equal(done.ok, true, done.detail);
  assert.equal((await chat("gemini-cli", "gemini-3.8-flash-high")).text, "hi from gemini");
});

console.log(`subscription: ${passed} passed`);
fs.rmSync(dir, { recursive: true, force: true });
process.exit(0);
