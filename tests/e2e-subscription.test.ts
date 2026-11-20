/**
 * A chat on a subscription CLI, through the whole server: a stand-in Claude Code streams a sentence, writes a file with its own
 * Write tool, and finishes. What the person should see: the sentence whole, then the step, then the file it made as a code
 * card (the same one the agent's own edits get), then the rest -- and the file in the chat's own folder, where the windows and
 * Artifacts look, not in a scratch folder nobody sees.
 *
 *   npm test -- e2e-subscription
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { derive } from "../src/lib/derive";
import type { AutoraEvent } from "../src/lib/types";
import { startApp } from "./e2e-harness";

const bin = fs.mkdtempSync(path.join(os.tmpdir(), "autora-e2e-sub-"));
const argvLog = path.join(bin, "argv.json");
fs.writeFileSync(path.join(bin, "claude"), `#!${process.execPath}
const fs = require("node:fs"), path = require("node:path");
fs.writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));
const say = (o) => console.log(JSON.stringify(o));
const piece = (text) => say({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } });
process.stdin.resume();
process.stdin.on("end", () => {
  say({ type: "stream_event", event: { type: "message_start" } });
  piece("I am making the page");
  piece(" for you right now.");
  const file = path.join(process.cwd(), "index.html");
  say({ type: "assistant", message: { content: [{ type: "text", text: "I am making the page for you right now." }, { type: "tool_use", name: "Write", input: { file_path: file } }] } });
  fs.writeFileSync(file, "<h1>Hi</h1>\\n");
  setTimeout(() => {
    say({ type: "stream_event", event: { type: "message_start" } });
    piece("Done.");
    say({ type: "assistant", message: { content: [{ type: "text", text: "Done." }] } });
    say({ type: "result", result: "Done.", usage: { input_tokens: 5, output_tokens: 6 } });
  }, 300);
});
`, { mode: 0o755 });

const app = await startApp({ env: { PATH: `${bin}${path.delimiter}${process.env.PATH}` } });
let passed = 0;
try {
  await app.api("PATCH", "/api/settings", { provider: "claude-cli" });
  const session = await app.newSession("Subscription", "build");
  const events = await app.turn(session, "Make me a page.", 60_000);

  const failed = events.find((e) => e.kind === "system.error");
  assert.equal(failed, undefined, JSON.stringify(failed?.payload));

  const seen = JSON.parse(fs.readFileSync(argvLog, "utf8")) as { argv: string[]; cwd: string };
  assert.equal(path.resolve(seen.cwd), path.resolve(app.home), "it works in the chat's own folder");
  assert.ok(fs.existsSync(path.join(app.home, "index.html")));
  assert.ok(seen.argv.includes("--append-system-prompt-file"), "Autora's instructions go as the system prompt");
  assert.ok(seen.argv.includes("--include-partial-messages"), "and it streams");
  console.log("  ok  it runs in the chat's folder, streaming, with the instructions as a system prompt");
  passed += 1;

  const cells = derive(events as unknown as AutoraEvent[]).buckets.flatMap((b) => b.cells)
    .filter((c: any) => ["reply", "tool", "file"].includes(c.kind))
    .map((c: any) => (c.kind === "reply" ? `reply:${c.turn.text.trim()}` : c.kind === "tool" ? `tool:${c.span.name}` : `file:${c.file.path}`));
  assert.deepEqual(cells, ["reply:I am making the page for you right now.", "tool:Write", "file:index.html", "reply:Done."]);
  console.log("  ok  the sentence stays whole, the step and the file it made follow it, then the rest");
  passed += 1;

  /* Autora's own tools, through the bridge: a stand-in Claude starts the MCP server from the config it was handed, exactly as
     Claude Code does, lists the tools, and opens the board with one. */
  const bridgeLog = path.join(bin, "bridge.json");
  fs.writeFileSync(path.join(bin, "claude"), `#!${process.execPath}
const fs = require("node:fs"), { spawn } = require("node:child_process");
const argv = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(argv[argv.indexOf("--mcp-config") + 1], "utf8")).mcpServers.autora;
const allowed = argv.slice(argv.indexOf("--allowedTools") + 1);
const server = spawn(config.command, config.args, { env: { ...process.env, ...config.env }, stdio: ["pipe", "pipe", "inherit"] });
const waiting = new Map(); let held = "", next = 1;
server.stdout.setEncoding("utf8");
server.stdout.on("data", (c) => { held += c; let at; while ((at = held.indexOf("\\n")) >= 0) { const m = JSON.parse(held.slice(0, at)); held = held.slice(at + 1); waiting.get(m.id)?.(m); } });
const rpc = (method, params) => new Promise((resolve) => { const id = next++; waiting.set(id, resolve); server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\\n"); });
const say = (o) => console.log(JSON.stringify(o));
process.stdin.resume();
process.stdin.on("end", async () => {
  const init = await rpc("initialize", { protocolVersion: "2025-06-18" });
  const list = await rpc("tools/list", {});
  say({ type: "assistant", message: { content: [{ type: "text", text: "Opening the board." }, { type: "tool_use", name: "mcp__autora__panacea_open", input: {} }] } });
  const call = await rpc("tools/call", { name: "panacea_open", arguments: {} });
  const own = await rpc("tools/call", { name: "autora_tool", arguments: { name: "terminal", args: { command: "ls" } } });
  fs.writeFileSync(${JSON.stringify(bridgeLog)}, JSON.stringify({ allowed, env: config.env, server: init.result.serverInfo, names: list.result.tools.map((t) => t.name), call: call.result, own: own.result }));
  server.stdin.end();
  say({ type: "assistant", message: { content: [{ type: "text", text: "It is open." }] } });
  say({ type: "result", result: "Opening the board. It is open." });
});
`, { mode: 0o755 });
  const board = await app.newSession("Board", "build");
  const boardEvents = await app.turn(board, "Open the board.", 60_000);
  const failedBoard = boardEvents.find((e) => e.kind === "system.error");
  assert.equal(failedBoard, undefined, JSON.stringify(failedBoard?.payload));
  const bridged = JSON.parse(fs.readFileSync(bridgeLog, "utf8"));
  assert.equal(bridged.server.name, "autora");
  assert.ok(bridged.allowed.includes("mcp__autora"), "every Autora tool is allowed: Autora checks each call itself");
  assert.ok(bridged.names.includes("panacea_open") && bridged.names.includes("autora_tool"), bridged.names.join(","));
  for (const own of ["terminal", "read_file", "edit_file", "claude_cli", "gemini_cli"]) assert.ok(!bridged.names.includes(own), `${own} is the CLI's own job`);
  assert.equal(bridged.call.isError, false, JSON.stringify(bridged.call));
  assert.equal(bridged.own.isError, true, "the CLI's own jobs are not run through the bridge either way");
  console.log("  ok  the CLI gets Autora's tools (not the ones it has its own of) and its call runs");
  passed += 1;

  const opened = boardEvents.find((e) => e.kind === "tool.call" && e.payload.name === "panacea_open");
  assert.ok(opened, "the call is Autora's own tool call, with its own cells");
  assert.ok(boardEvents.some((e) => e.span === opened.span && e.kind === "tool.result"), "and its result");
  assert.ok(!boardEvents.some((e) => e.kind === "vendor.tool" && String(e.payload.text).includes("panacea_open")), "not drawn twice");
  const replies = derive(boardEvents as unknown as AutoraEvent[]).buckets.flatMap((b) => b.cells)
    .filter((c: any) => c.kind === "reply" || c.kind === "tool").map((c: any) => (c.kind === "reply" ? c.turn.text.trim() : `tool:${c.span.name}`));
  assert.deepEqual(replies.slice(0, 2), ["Opening the board.", "tool:panacea_open"]);
  console.log("  ok  the call shows as Autora's own step, after what was said before it, once");
  passed += 1;

  const late = await fetch(bridged.env.AUTORA_BRIDGE_URL, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${bridged.env.AUTORA_BRIDGE_TOKEN}` },
    body: JSON.stringify({ op: "list" }),
  });
  assert.equal(late.status, 401, "the turn's token is no good once the turn is over");
  const guessed = await fetch(bridged.env.AUTORA_BRIDGE_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op: "list" }) });
  assert.equal(guessed.status, 401);
  console.log("  ok  the bridge closes with its turn, and takes nothing without its token");
  passed += 1;
} finally {
  await app.stop();
  fs.rmSync(bin, { recursive: true, force: true });
}
console.log(`e2e-subscription: ${passed} passed`);
process.exit(0);
