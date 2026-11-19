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

await test("Claude without write may only read", async () => {
  withCli();
  await run("claude");
  const argv = JSON.parse(fs.readFileSync(argvLog, "utf8")) as string[];
  assert.ok(!argv.includes("acceptEdits"));
  assert.deepEqual(argv.slice(argv.indexOf("--allowedTools")), ["--allowedTools", "Read", "Glob", "Grep"]);
});

await test("Claude: a sign-in that has lapsed, and a limit that has been reached, are told apart", async () => {
  withCli();
  process.env.CLAUDE_STUB = "auth";
  const signedOut = (await run("claude")).result;
  assert.equal(signedOut.ok, false);
  assert.equal(signedOut.reason, "auth");
  assert.match(signedOut.message, /sign in once in the Autora container/);
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
  assert.deepEqual(argv.slice(-2), ["--approval-mode", "auto_edit"]);
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
