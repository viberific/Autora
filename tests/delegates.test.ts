/**
 * The bundled delegate wrappers (server/delegates/): Autora hands a job to the Claude Code or Gemini CLI through them, with
 * stand-ins for the CLIs here (a script that prints what the real one prints). What is checked is the translation into the
 * stream contract of server/vendor.ts, through the server's own runVendor: text streamed as it comes, the tools it called
 * shown as status, the result and its usage, the CLI's own refusals sorted into a sign-in or a wait, and a missing CLI said
 * to be missing rather than offered.
 *
 *   npx tsx tests/delegates.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autora-delegates-"));
const bin = path.join(dir, "bin");
const work = path.join(dir, "work");
fs.mkdirSync(bin);
fs.mkdirSync(work);
process.env.AUTORA_STATE_DIR = dir;
// The box's own bin folder (/data/bin in the image): empty unless a test puts agy there.
const boxBin = path.join(dir, "boxbin");
fs.mkdirSync(boxBin);
process.env.AUTORA_BIN_DIR = boxBin;
// The wrappers this server carries, not any the machine has set up.
delete process.env.AUTORA_CLAUDE_CLI;
delete process.env.AUTORA_GEMINI_CLI;
const realPath = process.env.PATH ?? "";

const stub = (name: string, body: string) => {
  const file = path.join(bin, name);
  fs.writeFileSync(file, `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
};
const argvLog = path.join(dir, "argv.json");
const stdinLog = path.join(dir, "stdin.txt");

// A stand-in for `claude -p --output-format stream-json --verbose`: remembers how it was called, says two things, calls a tool, and
// finishes with a result carrying usage. CLAUDE_STUB picks another ending.
stub("claude", `
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)));
let input = ""; process.stdin.on("data", (c) => input += c); process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(stdinLog)}, input);
  const say = (o) => console.log(JSON.stringify(o));
  const mode = process.env.CLAUDE_STUB || "ok";
  if (mode === "auth") { say({ type: "result", subtype: "success", is_error: true, result: "Invalid API key · Please run /login" }); return; }
  if (mode === "limit") { console.error("Claude usage limit reached. Your limit will reset at 9pm."); process.exit(1); }
  if (mode === "partial") {
    // --include-partial-messages: the words in pieces, then the finished message repeating them.
    const ev = (event) => say({ type: "stream_event", event });
    ev({ type: "message_start" });
    ev({ type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } });
    ev({ type: "content_block_delta", delta: { type: "text_delta", text: "lo." } });
    say({ type: "assistant", message: { content: [{ type: "text", text: "Hello." }, { type: "tool_use", name: "Read", input: { file_path: "a.ts" } }] } });
    say({ type: "result", subtype: "success", is_error: false, result: "Hello." });
    return;
  }
  say({ type: "system", subtype: "init" });
  say({ type: "assistant", message: { content: [{ type: "text", text: "Looking at it. " }, { type: "tool_use", name: "Read", input: { file_path: "src/a.ts" } }] } });
  say({ type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "src/a.ts" } }, { type: "text", text: "Done." }] } });
  say({ type: "result", subtype: "success", is_error: false, result: "Looking at it. Done.", usage: { input_tokens: 11, output_tokens: 7 }, total_cost_usd: 0.01 });
});`);
// A stand-in for `gemini -p ... -o stream-json`.
stub("gemini", `
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(argvLog + ".g")}, JSON.stringify(process.argv.slice(2)));
const say = (o) => console.log(JSON.stringify(o));
const mode = process.env.GEMINI_STUB || "ok";
if (mode === "plain") { console.log("an old CLI"); console.log("prints plain text"); process.exit(0); }
if (mode === "auth") { console.error("Error: Please sign in. Authentication required (401)"); process.exit(1); }
if (mode === "no-method") { console.error("Please set an Auth method in your ~/.gemini/settings.json or specify one of the following environment variables before running: GEMINI_API_KEY"); process.exit(41); }
say({ type: "init" });
say({ type: "message", role: "assistant", content: "Gemini says ", delta: true });
say({ type: "tool_use", tool_name: "read_file", parameters: { file_path: "README.md" } });
say({ type: "message", role: "assistant", content: "hello.", delta: true });
say({ type: "result", status: "success", stats: { input_tokens: 5, output_tokens: 3 } });`);

const { runVendor, vendorReady } = await import("../server/vendor");

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}
const withCli = () => { process.env.PATH = `${bin}${path.delimiter}${realPath}`; };
const withoutCli = () => { process.env.PATH = path.join(dir, "empty"); };
const run = (id: "claude" | "gemini", extra: Record<string, unknown> = {}) => {
  const statuses: string[] = [];
  const deltas: string[] = [];
  return runVendor({ id, prompt: "check the code", cwd: work, onStatus: (s: string) => statuses.push(s), onDelta: (d: string) => deltas.push(d), ...extra } as never)
    .then((result) => ({ result, statuses, deltas }));
};

await test("the bundled wrapper is ready only when its CLI is installed", async () => {
  withoutCli();
  const missing = vendorReady("claude");
  assert.equal(missing.ok, false);
  assert.match(missing.detail, /claude CLI is not installed/);
  assert.match(missing.detail, /npm install -g @anthropic-ai\/claude-code/);
  assert.equal(vendorReady("gemini").ok, false);
  withCli();
  assert.equal(vendorReady("claude").ok, true);
  assert.equal(vendorReady("gemini").ok, true);
});

await test("a missing CLI is said to be missing, not run", async () => {
  withoutCli();
  const { result } = await run("claude");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "not_installed");
});

await test("Claude: the prompt goes on standard input; the text streams, its tools show as status, the result has usage and what it edited", async () => {
  withCli();
  const { result, statuses, deltas } = await run("claude", { write: true, model: "sonnet" });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.text, "Looking at it. Done.");
  assert.ok(deltas.join("").includes("Looking at it."));
  assert.deepEqual(statuses, ["Read src/a.ts", "Edit src/a.ts"]);
  assert.deepEqual(result.usage && { in: result.usage.input_tokens, out: result.usage.output_tokens }, { in: 11, out: 7 });
  assert.ok(result.files.some((f: string) => f.endsWith("src/a.ts")), JSON.stringify(result.files));
  assert.equal(fs.readFileSync(stdinLog, "utf8"), "check the code");
  const argv = JSON.parse(fs.readFileSync(argvLog, "utf8")) as string[];
  assert.deepEqual(argv.slice(0, 4), ["-p", "--output-format", "stream-json", "--verbose"]);
  assert.ok(argv.includes("--model") && argv.includes("sonnet"));
  assert.ok(argv.includes("acceptEdits"), "write lets it edit");
});

await test("Claude streams its words as they are written, once each, with its effort and its instructions as a system prompt", async () => {
  withCli();
  process.env.CLAUDE_STUB = "partial";
  const { result, deltas, statuses } = await run("claude", { effort: "low", system: "Be brief." });
  delete process.env.CLAUDE_STUB;
  assert.equal(result.ok, true, result.message);
  assert.equal(deltas.join(""), "Hello.", "the finished message does not say it twice");
  assert.deepEqual(statuses, ["Read a.ts"]);
  const argv = JSON.parse(fs.readFileSync(argvLog, "utf8")) as string[];
  assert.ok(argv.includes("--include-partial-messages"));
  assert.deepEqual(argv.slice(argv.indexOf("--effort"), argv.indexOf("--effort") + 2), ["--effort", "low"]);
  assert.ok(argv.includes("--append-system-prompt-file"));
  assert.equal(fs.readFileSync(stdinLog, "utf8"), "check the code", "the instructions are not in the prompt");
});

await test("Claude without write may only read", async () => {
  withCli();
  await run("claude");
  const argv = JSON.parse(fs.readFileSync(argvLog, "utf8")) as string[];
  assert.ok(!argv.includes("acceptEdits"));
  assert.deepEqual(argv.slice(argv.indexOf("--allowedTools"), argv.indexOf("--allowedTools") + 4), ["--allowedTools", "Read", "Glob", "Grep"]);
});

await test("Claude: a sign-in that has lapsed, and a limit that has been reached, are told apart", async () => {
  withCli();
  process.env.CLAUDE_STUB = "auth";
  const signedOut = (await run("claude")).result;
  assert.equal(signedOut.ok, false);
  assert.equal(signedOut.reason, "auth");
  assert.match(signedOut.message, /sign in under Settings/);
  process.env.CLAUDE_STUB = "limit";
  const limited = (await run("claude")).result;
  assert.equal(limited.reason, "rate_limit");
  delete process.env.CLAUDE_STUB;
});

await test("Gemini: its text streams, its tool shows as status, usage comes through, and a write is approved for edits only", async () => {
  withCli();
  const { result, statuses } = await run("gemini", { write: true });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.text, "Gemini says hello.");
  assert.deepEqual(statuses, ["read_file README.md"]);
  assert.deepEqual(result.usage && { in: result.usage.input_tokens, out: result.usage.output_tokens }, { in: 5, out: 3 });
  const argv = JSON.parse(fs.readFileSync(argvLog + ".g", "utf8")) as string[];
  assert.deepEqual(argv.slice(0, 4), ["-p", "check the code", "-o", "stream-json"]);
  assert.deepEqual(argv.slice(-3), ["--approval-mode", "auto_edit", "--skip-trust"]);
});

await test("Gemini: an Antigravity model name is not handed to the gemini CLI, which does not know it", async () => {
  withCli();
  await run("gemini", { model: "gemini-3.8-flash-high" });
  const argv = JSON.parse(fs.readFileSync(argvLog + ".g", "utf8")) as string[];
  assert.ok(!argv.includes("-m"), argv.join(" "));
});

await test("Gemini: agy in the box's own bin folder (off PATH) is found, preferred, and its stream read", async () => {
  // Node on PATH for the wrapper itself, and neither CLI.
  process.env.PATH = path.dirname(process.execPath);
  const agy = path.join(boxBin, "agy");
  fs.writeFileSync(agy, `#!${process.execPath}
require("node:fs").writeFileSync(${JSON.stringify(argvLog + ".a")}, JSON.stringify(process.argv.slice(2)));
const say = (o) => console.log(JSON.stringify(o));
say({ event: "init" });
say({ event: "step_update", step_update: { step_type: "agent_response", state: "ACTIVE", text_delta: "From " } });
say({ event: "step_update", step_update: { step_type: "tool", state: "ACTIVE", tool_name: "view_file", tool_info: { parameters: { Path: "a.md" } } } });
say({ event: "step_update", step_update: { step_type: "agent_response", state: "ACTIVE", text_delta: "agy." } });
say({ event: "result", result: { status: "SUCCESS", response: "From agy." } });
`, { mode: 0o755 });
  try {
    assert.equal(vendorReady("gemini").ok, true, "agy off PATH still counts");
    const { result, statuses } = await run("gemini", { write: true, model: "gemini-3.8-flash-high" });
    assert.equal(result.ok, true, result.message);
    assert.equal(result.text, "From agy.");
    assert.deepEqual(statuses, ["view_file a.md"]);
    const argv = JSON.parse(fs.readFileSync(argvLog + ".a", "utf8")) as string[];
    assert.ok(argv.includes("--model") && argv.includes("gemini-3.8-flash-high"));
    assert.ok(argv.includes("--dangerously-skip-permissions"));
    withCli();
    await run("gemini");
    assert.ok(fs.existsSync(argvLog + ".a"), "with both, agy answers");
  } finally {
    fs.rmSync(agy);
  }
});

await test("Gemini: the CLI asking for an auth method is a sign-in to make, not an unknown failure", async () => {
  withCli();
  process.env.GEMINI_STUB = "no-method";
  const out = (await run("gemini")).result;
  assert.equal(out.reason, "auth", out.message);
  assert.match(out.message, /Settings/);
  delete process.env.GEMINI_STUB;
});

await test("Gemini: an older CLI that only prints plain text still answers, and a sign-in that is needed is said", async () => {
  withCli();
  process.env.GEMINI_STUB = "plain";
  assert.equal((await run("gemini")).result.text.trim(), "an old CLI\nprints plain text");
  process.env.GEMINI_STUB = "auth";
  const out = (await run("gemini")).result;
  assert.equal(out.ok, false);
  assert.equal(out.reason, "auth");
  delete process.env.GEMINI_STUB;
});

await test("a wrapper the person wrote at its own path keeps its place over the bundled one", async () => {
  const mine = path.join(dir, "mine.sh");
  fs.writeFileSync(mine, '#!/bin/sh\necho \'{"type":"result","text":"from mine"}\'\n', { mode: 0o755 });
  process.env.AUTORA_CLAUDE_CLI = mine;
  withoutCli();
  assert.equal(vendorReady("claude").ok, true, "no CLI needed: it is theirs");
  assert.equal((await run("claude")).result.text, "from mine");
  delete process.env.AUTORA_CLAUDE_CLI;
});

console.log(`delegates: ${passed} passed`);
process.exit(0);
