#!/usr/bin/env node
/**
 * Hands a job to Gemini (the `gemini` CLI, signed in as the person) and speaks server/vendor.ts's stream contract back.
 *
 * `gemini -p ... -o stream-json` prints one JSON object a line: `message`s from the model (with `delta` pieces), the `tool_use`
 * it makes, and a `result`. A line that is not JSON is read as answer text, so an older CLI that only prints plain text still
 * works. Without --write nothing is approved for it to run; with it, edits are approved (`auto_edit`).
 */
import { brief, emit, fail, onPath, readOptions, reasonOf, runCli } from "./common.mjs";

const opts = await readOptions(process.argv.slice(2));
const bin = onPath("gemini");
if (!bin) fail("not_installed", "The gemini CLI is not installed here (npm install -g @google/gemini-cli).");

// A long prompt goes on standard input (the command line has a limit); `-p` then only says what to do with it.
const long = opts.prompt.length > 60_000;
const args = ["-p", long ? "Do what is asked above." : opts.prompt, "-o", "stream-json"];
if (opts.model) args.push("-m", opts.model);
if (opts.write) args.push("--approval-mode", "auto_edit");

let answer = "";
let usage = null;
let problem = "";
const edited = new Set();

const line = (raw) => {
  const text = raw.replace(/\r$/, "");
  if (!text.trim()) return;
  let event = null;
  try { event = JSON.parse(text); } catch { /* plain text */ }
  if (!event || typeof event !== "object") { answer += `${text}\n`; emit({ type: "delta", text: `${text}\n` }); return; }
  if (event.type === "message" && event.role === "assistant" && typeof event.content === "string") { answer += event.content; emit({ type: "delta", text: event.content }); }
  else if (event.type === "tool_use") {
    const name = event.tool_name ?? event.name ?? "tool";
    const input = event.parameters ?? event.input ?? {};
    emit({ type: "status", text: brief(name, input) });
    const file = input?.file_path ?? input?.path;
    if (typeof file === "string" && /write|edit|replace/i.test(name)) edited.add(file);
  } else if (event.type === "result") {
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
  const said = done.stderr.trim() || "gemini stopped without an answer.";
  fail(reasonOf(said), said);
}
emit({ type: "result", text: answer.trim(), ...(edited.size ? { files: [...edited] } : {}), ...(usage ? { usage } : {}) });
