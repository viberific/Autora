/**
 * Per-model knobs (server/modelprofile.ts): each model is sent the fields it takes and not the ones it refuses, and a
 * model the table does not know learns from its own refusal. Bodies are read off a real HTTP server, as in
 * thinking-off.test.ts. Also: the worker's model (server/roles.ts workerTarget) and the Anthropic price table.
 *
 *   npx tsx tests/modelprofile.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

process.env.AUTORA_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "autora-profile-"));
const { streamChat } = await import("../server/llm");
const { claudeVersion, modelProfile, forgetRefusals } = await import("../server/modelprofile");
const { workerTarget } = await import("../server/roles");
const { cheaperSibling, costOf } = await import("../server/providers");

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

console.log("model profiles");

await test("Claude versions are read from every spelling", () => {
  assert.deepEqual(claudeVersion("claude-opus-4-7"), { family: "opus", version: 4.7 });
  assert.deepEqual(claudeVersion("claude-sonnet-5-5"), { family: "sonnet", version: 5.5 });
  assert.deepEqual(claudeVersion("claude-sonnet-5"), { family: "sonnet", version: 5 });
  assert.deepEqual(claudeVersion("claude-haiku-4-5-20251001"), { family: "haiku", version: 4.5 });
  assert.deepEqual(claudeVersion("anthropic/claude-sonnet-4.5"), { family: "sonnet", version: 4.5 });
  assert.equal(claudeVersion("gpt-5"), null);
});

await test("newest Claude: no temperature, takes effort; older Claude: the other way round", () => {
  for (const m of ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-4-7", "claude-fable-5-1"]) {
    assert.deepEqual(modelProfile("anthropic", m), { effort: "anthropic", temperature: false }, m);
  }
  assert.deepEqual(modelProfile("anthropic", "claude-sonnet-4-6"), { effort: "anthropic", temperature: true });
  for (const m of ["claude-haiku-4-5", "claude-sonnet-4-5", "claude-opus-4-1"]) {
    assert.deepEqual(modelProfile("anthropic", m), { effort: null, temperature: true }, m);
  }
});

await test("OpenAI's reasoning models take reasoning effort; everything else gets the common fields only", () => {
  assert.deepEqual(modelProfile("openai", "gpt-5-mini"), { effort: "openai", temperature: false });
  assert.deepEqual(modelProfile("openai", "o4-mini"), { effort: "openai", temperature: false });
  assert.deepEqual(modelProfile("openai", "gpt-4o-mini"), { effort: null, temperature: true });
  assert.deepEqual(modelProfile("openai", "gpt-7"), { effort: "openai", temperature: false }, "later generations too");
  assert.deepEqual(modelProfile("openai", "gpt-6-luna"), { effort: "openai", temperature: false });
  assert.deepEqual(modelProfile("deepseek", "deepseek-flash"), { effort: null, temperature: true });
  assert.deepEqual(modelProfile("openrouter", "openai/gpt-5"), { effort: null, temperature: true }, "a gateway is not assumed to pass it on");
});

// ---- the wire
const bodies: any[] = [];
let refuse: RegExp | null = null;
let refusal = "";
const vendor = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    const body = JSON.parse(raw);
    bodies.push(body);
    if (refuse && refuse.test(raw)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return void res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: refusal } }));
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    if (req.url?.includes("/v1/messages")) {
      const ev = (o: unknown) => res.write(`event: x\ndata: ${JSON.stringify(o)}\n\n`);
      ev({ type: "message_start", message: { usage: { input_tokens: 1, output_tokens: 0 } } });
      ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } });
      ev({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } });
      ev({ type: "message_stop" });
    } else {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`);
      res.write("data: [DONE]\n\n");
    }
    res.end();
  });
});
vendor.listen(0);
await new Promise((r) => vendor.once("listening", r));
const root = `http://127.0.0.1:${(vendor.address() as { port: number }).port}`;

const claude = (model: string, effort?: "low") => streamChat({
  provider: "anthropic", model, key: "k", baseUrl: root, system: "s", messages: [{ role: "user", text: "hi" }],
  temperature: 0.2, ...(effort ? { effort } : {}),
}, () => undefined);
const openai = (model: string, effort?: "low") => streamChat({
  provider: "openai", model, key: "k", baseUrl: `${root}/v1`, system: "s", messages: [{ role: "user", text: "hi" }],
  temperature: 0.2, ...(effort ? { effort } : {}),
}, () => undefined);

await test("effort is picked per model when nobody set it: low for small talk, medium for Sonnet's work, else the model's own", async () => {
  const { autoEffort } = await import("../server/modelprofile");
  assert.equal(autoEffort("anthropic", "claude-sonnet-5-5", "work"), "medium");
  assert.equal(autoEffort("anthropic", "claude-sonnet-5-5", "chat"), "low");
  assert.equal(autoEffort("anthropic", "claude-opus-5-5", "work"), undefined, "its default is already medium");
  assert.equal(autoEffort("openai", "gpt-6-luna", "chat"), "low");
  assert.equal(autoEffort("openai", "gpt-6-luna", "work"), undefined);
  assert.equal(autoEffort("deepseek", "deepseek-flash", "chat"), undefined, "a model with no such knob is sent nothing");
  assert.equal(autoEffort("anthropic", "claude-haiku-4-5", "chat"), undefined);
});

console.log("on the wire");

await test("Opus 5.5 is sent effort and no temperature", async () => {
  bodies.length = 0;
  assert.equal((await claude("claude-opus-5-5", "low")).text, "hi");
  assert.equal(bodies[0].temperature, undefined);
  assert.deepEqual(bodies[0].output_config, { effort: "low" });
});

await test("Haiku 4.5 keeps its temperature and is sent no effort", async () => {
  bodies.length = 0;
  await claude("claude-haiku-4-5", "low");
  assert.equal(bodies[0].temperature, 0.2);
  assert.equal(bodies[0].output_config, undefined);
});

await test("no effort asked, none sent: the model's own default stands", async () => {
  bodies.length = 0;
  await claude("claude-opus-5-5");
  assert.equal(bodies[0].output_config, undefined);
});

await test("a Claude model the table gets wrong refuses temperature once, is asked again without it, and is not sent it again", async () => {
  forgetRefusals();
  refuse = /"temperature"/;
  refusal = "temperature: this model does not support sampling parameters";
  bodies.length = 0;
  assert.equal((await claude("claude-sonnet-4-6")).text, "hi");
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].temperature, 0.2);
  assert.equal(bodies[1].temperature, undefined);
  bodies.length = 0;
  await claude("claude-sonnet-4-6");
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].temperature, undefined);
  refuse = null;
});

await test("GPT-5 is sent reasoning effort; GPT-4o-mini is not", async () => {
  bodies.length = 0;
  await openai("gpt-5-mini", "low");
  await openai("gpt-4o-mini", "low");
  assert.equal(bodies[0].reasoning_effort, "low");
  assert.equal(bodies[0].temperature, undefined);
  assert.equal(bodies[1].reasoning_effort, undefined);
  assert.equal(bodies[1].temperature, 0.2);
});

await test("an OpenAI model that refuses reasoning effort learns it", async () => {
  forgetRefusals();
  refuse = /reasoning_effort/;
  refusal = "Unsupported parameter: 'reasoning_effort' is not supported with this model.";
  bodies.length = 0;
  assert.equal((await openai("o1-preview", "low")).text, "hi");
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1].reasoning_effort, undefined);
  refuse = null;
});

await test("any other 400 is still an error, asked once", async () => {
  forgetRefusals();
  refuse = /./;
  refusal = "messages: roles must alternate";
  bodies.length = 0;
  await assert.rejects(claude("claude-opus-5-5", "low"), /alternate/);
  assert.equal(bodies.length, 1);
  refuse = null;
});

vendor.close();

console.log("models and prices");

await test("the research worker runs on a cheaper model of the same provider, unless told otherwise", () => {
  const main = { provider: "anthropic", model: "claude-opus-5-5", key: "k", baseUrl: "u" };
  const cheap = cheaperSibling("anthropic", "claude-opus-5-5");
  assert.equal(cheap, "claude-haiku-5-5");
  assert.equal(workerTarget(main, undefined, cheap).model, "claude-haiku-5-5");
  assert.equal(workerTarget(main, "main", cheap).model, "claude-opus-5-5");
  assert.equal(workerTarget(main, "claude-sonnet-5-5", cheap).model, "claude-sonnet-5-5");
  assert.equal(workerTarget({ ...main, provider: "deepseek", model: "deepseek-flash" }, undefined, cheaperSibling("deepseek", "deepseek-flash")).model, "deepseek-flash", "already the cheap one");
});

await test("Haiku 5.5 is billed at its dearer price past 100K tokens, and cache reads at their own price", () => {
  const short = costOf("anthropic", "claude-haiku-5-5", 100_000, 1_000);
  assert.ok(Math.abs(short - (0.1 * 0.1 + 0.5 * 0.001)) < 1e-9, String(short));
  const long = costOf("anthropic", "claude-haiku-5-5", 200_000, 1_000);
  assert.ok(Math.abs(long - (0.5 * 0.2 + 2.5 * 0.001)) < 1e-9, String(long));
  const read = costOf("anthropic", "claude-opus-5-5", 1_000_000, 0, new Date(), { read: 1_000_000 });
  assert.ok(Math.abs(read - 0.2) < 1e-9, String(read));
});

console.log(`${passed} passed`);
