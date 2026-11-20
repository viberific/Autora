#!/usr/bin/env node
/**
 * Hands a job to Claude Code (the `claude` CLI, signed in as the person) and speaks server/vendor.ts's stream contract back.
 *
 * `claude -p --output-format stream-json --verbose` prints one JSON object a line: `assistant` messages (text, and the tools it
 * is calling), then a `result` with the whole answer and what it cost. Text becomes deltas, tool calls become status lines, the
 * result is the result. Without --write it may only read (Read, Glob, Grep); with it, edits are accepted without asking, since
 * nobody is there to ask. The folder it is pointed at is added to the workspace (`--add-dir`): outside it every read is refused,
 * and a turn asked to look at a file elsewhere would answer that it could not.
 *
 * `--include-partial-messages` makes it stream: without it the text of each message arrives only once that whole message is
 * written, so a reply sat silent and then appeared at once. The pieces come as `stream_event` text deltas, and the finished
 * `assistant` message then repeats the text, so its text is only used where no piece came. A `--system-file` is passed as
 * `--append-system-prompt-file`: instructions that stay the same from turn to turn sit in the system prompt, where the vendor
 * caches them, instead of at the head of a new message every turn.
 */
import { autoraBridge, brief, emit, fail, onPath, privateFile, readOptions, reasonOf, runCli } from "./common.mjs";

const opts = await readOptions(process.argv.slice(2));
const bin = onPath("claude");
if (!bin) fail("not_installed", "The claude CLI is not installed here (npm install -g @anthropic-ai/claude-code).");

const args = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"];
if (opts.model) args.push("--model", opts.model);
if (opts.effort) args.push("--effort", opts.effort);
if (opts.systemFile) args.push("--append-system-prompt-file", opts.systemFile);
const allowed = opts.write ? [] : ["Read", "Glob", "Grep"];
if (opts.write) args.push("--permission-mode", "acceptEdits");
/* Autora's own tools, when the turn offers them: an MCP server of their own ("autora"), every one of them allowed, since Autora
   runs its own checks (and the person's Ask mode) on each call before it does anything. */
const bridge = autoraBridge();
if (bridge) {
  args.push("--mcp-config", privateFile("mcp.json", JSON.stringify({ mcpServers: { autora: { type: "stdio", ...bridge } } })));
  allowed.push("mcp__autora");
  // A window's tool can take a while (a document opening, a page loading): not cut off at the CLI's default.
  process.env.MCP_TOOL_TIMEOUT ||= "600000";
  /* Autora's tools are loaded with the turn, not looked up first: the lookup cost a round trip each time it was needed, and
     the instructions already say which tool does what. */
  process.env.ENABLE_TOOL_SEARCH ||= "false";
}
if (allowed.length) args.push("--allowedTools", ...allowed);
args.push("--add-dir", opts.cwd);

let answer = "";
/* Whether the message being written has streamed its text in pieces: then the finished message's text is the same words again. */
let streamedThisMessage = false;
let final = null;
let usage = null;
let problem = "";
const edited = new Set();

const line = (raw) => {
  const text = raw.trim();
  if (!text) return;
  let event;
  try { event = JSON.parse(text); } catch { return; }
  if (event?.type === "stream_event") {
    const e = event.event;
    if (e?.type === "message_start") streamedThisMessage = false;
    if (e?.type === "content_block_delta" && e.delta?.type === "text_delta" && typeof e.delta.text === "string" && e.delta.text) {
      streamedThisMessage = true;
      answer += e.delta.text;
      emit({ type: "delta", text: e.delta.text });
    }
    return;
  }
  if (event?.type === "assistant") {
    const pieces = streamedThisMessage;
    streamedThisMessage = false;
    for (const part of event.message?.content ?? []) {
      if (part?.type === "text" && typeof part.text === "string") {
        if (!pieces) { answer += part.text; emit({ type: "delta", text: part.text }); }
      }
      else if (part?.type === "tool_use") {
        /* Both: the status is the line the bubble keeps saying while it works, the tool line is the step in the chat. */
        emit({ type: "status", text: brief(part.name ?? "tool", part.input) });
        emit({ type: "tool", name: part.name ?? "tool", detail: brief("", part.input) });
        const file = part.input?.file_path ?? part.input?.path;
        if (typeof file === "string" && /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(part.name ?? "")) edited.add(file);
      }
    }
  } else if (event?.type === "result") {
    final = typeof event.result === "string" ? event.result : answer;
    const u = event.usage;
    if (u && typeof u === "object") usage = { input_tokens: u.input_tokens ?? 0, output_tokens: u.output_tokens ?? 0, ...(typeof event.total_cost_usd === "number" ? { cost_usd: event.total_cost_usd } : {}) };
    if (event.is_error === true || (typeof event.subtype === "string" && event.subtype.startsWith("error"))) problem = final || String(event.subtype);
  }
};

const done = await runCli({ bin, args, input: opts.prompt, cwd: opts.cwd, timeoutMs: opts.timeoutMs, onLine: line });
if (done.timedOut) fail("timeout", "It ran out of time and was stopped.");
if (done.spawnFailed) fail("not_installed", done.stderr);
if (problem) fail(reasonOf(problem), problem);
if (final == null) {
  const said = done.stderr.trim() || "claude stopped without an answer.";
  fail(reasonOf(said), said);
}
emit({ type: "result", text: final, ...(edited.size ? { files: [...edited] } : {}), ...(usage ? { usage } : {}) });
