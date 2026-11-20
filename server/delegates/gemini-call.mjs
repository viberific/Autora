#!/usr/bin/env node
/**
 * Hands a job to Gemini, signed in as the person, and speaks server/vendor.ts's stream contract back.
 *
 * Two CLIs can carry it, and the first one found is used:
 *
 * - Antigravity's `agy`, where a box has installed it (often in /data/bin). `agy -p ... --output-format stream-json` prints
 *   `{"event":"step_update",...}` lines and a closing `{"event":"result",...}`.
 * - Google's `gemini`, which the image ships and Settings can sign in (server/cli-signin.ts). `gemini -p ... -o stream-json`
 *   prints `message`s from the model (with `delta` pieces), the `tool_use` it makes, and a `result`.
 *
 * Both shapes are read by one parser, and a line that is not JSON is answer text, so an older CLI that only prints plain text
 * still works. Without --write nothing is approved for it to run; with it, edits are approved. For `gemini` the folder is trusted
 * for the run (`--skip-trust`): otherwise the CLI quietly drops back to approving every edit by hand, and with nobody there to
 * approve, a write turn stalls.
 */
import { brief, emit, fail, onPath, readOptions, reasonOf, runCli } from "./common.mjs";

const opts = await readOptions(process.argv.slice(2));
const agy = onPath("agy");
const bin = agy ?? onPath("gemini");
if (!bin) fail("not_installed", "Neither the Gemini CLI (npm install -g @google/gemini-cli) nor Antigravity's agy is installed here.");

// A long prompt goes on standard input (the command line has a limit); `-p` then only says what to do with it.
const long = opts.prompt.length > 60_000;
const ask = long ? "Do what is asked above." : opts.prompt;
const args = [];
if (agy) {
  args.push("-p", ask, "--output-format", "stream-json");
  if (opts.model) args.push("--model", opts.model);
  if (opts.effort) args.push("--effort", opts.effort);
  // Nobody is there to approve an edit, so it approves its own; without this a write turn stalls on a prompt.
  if (opts.write) args.push("--dangerously-skip-permissions");
  if (opts.cwd) args.push("--add-dir", opts.cwd);
} else {
  args.push("-p", ask, "-o", "stream-json");
  /* Antigravity names its models with the effort on the end (gemini-3.8-flash-high); `gemini` does not know those names and
     would refuse the turn, so it is left to pick its own model then. */
  if (opts.model && !/-(?:high|medium|low)$/.test(opts.model)) args.push("-m", opts.model);
  if (opts.write) args.push("--approval-mode", "auto_edit", "--skip-trust");
}

let answer = "";
let usage = null;
let problem = "";
const edited = new Set();

const toolCall = (name, input) => {
  /* Both: the status is the line the bubble keeps saying while it works, the tool line is the step in the chat. */
  emit({ type: "status", text: brief(name, input) });
  emit({ type: "tool", name, detail: brief("", input) });
  const file = input?.file_path ?? input?.path ?? input?.Path ?? input?.absolute_path;
  if (typeof file === "string" && /write|edit|replace/i.test(name)) edited.add(file);
};
const say = (text) => { answer += text; emit({ type: "delta", text }); };

const line = (raw) => {
  const text = raw.replace(/\r$/, "");
  if (!text.trim()) return;
  let event = null;
  try { event = JSON.parse(text); } catch { /* plain text */ }
  if (!event || typeof event !== "object") { say(`${text}\n`); return; }

  /* agy: the answer arrives as text_delta pieces and is repeated whole in the result, so the result only fills in when no
     delta came. */
  if (event.event === "step_update") {
    const step = event.step_update ?? {};
    if (step.step_type === "agent_response" && typeof step.text_delta === "string" && step.state === "ACTIVE") say(step.text_delta);
    if (step.step_type === "tool" && step.state === "ACTIVE") toolCall(step.tool_name ?? step.tool_info?.name ?? "tool", step.tool_info?.parameters ?? {});
    return;
  }
  if (event.event === "result") {
    const r = event.result ?? {};
    if (typeof r.response === "string" && r.response.trim() && !answer.trim()) say(r.response);
    const u = r.usage;
    if (u && typeof u === "object") usage = { input_tokens: u.input_tokens ?? 0, output_tokens: u.output_tokens ?? 0 };
    if (r.status && r.status !== "SUCCESS") problem = r.error ?? String(r.status);
    return;
  }
  if (event.event === "error") { problem = event.message ?? event.error ?? "the CLI reported an error"; return; }
  if (event.event) return;

  // gemini
  if (event.type === "message" && event.role === "assistant" && typeof event.content === "string") say(event.content);
  else if (event.type === "tool_use") toolCall(event.tool_name ?? event.name ?? "tool", event.parameters ?? event.input ?? {});
  else if (event.type === "result") {
    const s = event.stats;
    if (s && typeof s === "object") usage = { input_tokens: s.input_tokens ?? s.input ?? 0, output_tokens: s.output_tokens ?? s.output ?? 0 };
    if (event.status && event.status !== "success") problem = event.error?.message ?? String(event.status);
  } else if (event.type === "error") problem = event.message ?? event.error?.message ?? "gemini reported an error";
};

const done = await runCli({ bin, args, input: long ? opts.prompt : null, cwd: opts.cwd, timeoutMs: opts.timeoutMs, onLine: line });
if (done.timedOut) fail("timeout", "It ran out of time and was stopped.");
if (done.spawnFailed) fail("not_installed", done.stderr);
if (problem) fail(reasonOf(problem), problem);
if (done.code !== 0 && !answer.trim()) {
  const said = done.stderr.trim() || "the CLI stopped without an answer.";
  fail(reasonOf(said), said);
}
emit({ type: "result", text: answer.trim(), ...(edited.size ? { files: [...edited] } : {}), ...(usage ? { usage } : {}) });
