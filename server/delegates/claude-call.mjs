#!/usr/bin/env node
/**
 * Hands a job to Claude Code (the `claude` CLI, signed in as the person) and speaks server/vendor.ts's stream contract back.
 *
 * `claude -p --output-format stream-json --verbose` prints one JSON object a line: `assistant` messages (text, and the tools it
 * is calling), then a `result` with the whole answer and what it cost. Text becomes deltas, tool calls become status lines, the
 * result is the result. Without --write it may only read (Read, Glob, Grep); with it, edits are accepted without asking, since
 * nobody is there to ask. The folder it is pointed at is added to the workspace (`--add-dir`): outside it every read is refused,
 * and a turn asked to look at a file elsewhere would answer that it could not.
 */
import { brief, emit, fail, onPath, readOptions, reasonOf, runCli } from "./common.mjs";

const opts = await readOptions(process.argv.slice(2));
const bin = onPath("claude");
if (!bin) fail("not_installed", "The claude CLI is not installed here (npm install -g @anthropic-ai/claude-code).");

const args = ["-p", "--output-format", "stream-json", "--verbose"];
if (opts.model) args.push("--model", opts.model);
if (opts.write) args.push("--permission-mode", "acceptEdits", "--add-dir", opts.cwd);
else args.push("--allowedTools", "Read", "Glob", "Grep", "--add-dir", opts.cwd);

let answer = "";
let final = null;
let usage = null;
let problem = "";
const edited = new Set();

const line = (raw) => {
  const text = raw.trim();
  if (!text) return;
  let event;
  try { event = JSON.parse(text); } catch { return; }
  if (event?.type === "assistant") {
    for (const part of event.message?.content ?? []) {
      if (part?.type === "text" && typeof part.text === "string") { answer += part.text; emit({ type: "delta", text: part.text }); }
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
