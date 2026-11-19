#!/usr/bin/env node
/**
 * Hands a job to Gemini (the `gemini` CLI, signed in as the person) and speaks server/vendor.ts's stream contract back.
 *
 * `gemini -p ... -o stream-json` prints one JSON object a line: `message`s from the model (with `delta` pieces), the `tool_use`
 * it makes, and a `result`. A line that is not JSON is read as answer text, so an older CLI that only prints plain text still
 * works. Without --write nothing is approved for it to run; with it, edits are approved (`auto_edit`). The folder the wrapper is
 * pointed at is trusted for the run (`--skip-trust`): otherwise the CLI quietly drops back to approving every edit by hand, and
 * with nobody there to approve, a write turn stalls.
 */
import { brief, emit, fail, onPath, readOptions, reasonOf, runCli } from "./common.mjs";

const opts = await readOptions(process.argv.slice(2));
/* Antigravity's `agy`, not Google's `gemini`: `gemini` is also installed but carries no sign-in here, so every turn through it
   failed with "set an Auth method". `agy` is the CLI the subscription actually covers, and its token is kept fresh by
   /data/bin/agy-token-keep.py. */
const bin = onPath("agy");
if (!bin) fail("not_installed", "The Antigravity CLI (agy) is not installed here.");

// A long prompt goes on standard input (the command line has a limit); `-p` then only says what to do with it.
const long = opts.prompt.length > 60_000;
const args = ["-p", long ? "Do what is asked above." : opts.prompt, "--output-format", "stream-json"];
if (opts.model) args.push("--model", opts.model);
if (opts.effort) args.push("--effort", opts.effort);
// Nobody is there to approve an edit, so it approves its own; without this a write turn stalls on a prompt.
if (opts.write) args.push("--dangerously-skip-permissions");
if (opts.cwd) args.push("--add-dir", opts.cwd);

let answer = "";
let usage = null;
let problem = "";
const edited = new Set();

/* `agy` speaks its own stream shape, not the `gemini` one this wrapper was first written against:
 *   {"event":"step_update","step_update":{"step_type":"agent_response","text_delta":"..."}}
 *   {"event":"step_update",..."step_type":"tool_call"...}   and  {"event":"result","result":{"status":"SUCCESS","response":"..."}}
 * The answer arrives as text_delta pieces and is repeated whole in the result, so the result is used to settle the text rather
 * than append it a second time. */
const line = (raw) => {
  const text = raw.replace(/\r$/, "");
  if (!text.trim()) return;
  let event = null;
  try { event = JSON.parse(text); } catch { /* plain text */ }
  if (!event || typeof event !== "object") { answer += `${text}\n`; emit({ type: "delta", text: `${text}\n` }); return; }
  if (event.event === "init") return;
  if (event.event === "step_update") {
    const step = event.step_update ?? {};
    if (step.step_type === "agent_response" && typeof step.text_delta === "string" && step.state === "ACTIVE") {
      answer += step.text_delta;
      emit({ type: "delta", text: step.text_delta });
    }
    if (step.step_type === "tool" && step.state === "ACTIVE") {
      const name = step.tool_name ?? step.tool_info?.name ?? "tool";
      const input = step.tool_info?.parameters ?? {};
      emit({ type: "status", text: brief(name, input) });
      emit({ type: "tool", name, detail: brief(name, input) });
      const file = input?.file_path ?? input?.path ?? input?.Path ?? input?.absolute_path;
      if (typeof file === "string" && /write|edit|replace/i.test(name)) edited.add(file);
    }
    return;
  }
  if (event.event === "result") {
    const r = event.result ?? {};
    if (typeof r.response === "string" && r.response.trim()) {
      /* The deltas have already streamed the words; only fill in if none arrived (an older CLI that sends no deltas). */
      if (!answer.trim()) { answer = r.response; emit({ type: "delta", text: r.response }); }
    }
    const u = r.usage;
    if (u && typeof u === "object") usage = { input_tokens: u.input_tokens ?? 0, output_tokens: u.output_tokens ?? 0 };
    if (r.status && r.status !== "SUCCESS") problem = r.error ?? String(r.status);
    return;
  }
  if (event.event === "error") problem = event.message ?? event.error ?? "the CLI reported an error";
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
